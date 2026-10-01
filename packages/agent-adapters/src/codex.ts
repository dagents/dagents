/**
 * Codex adapter — spawn `codex exec --json "<prompt>"` and parse its NDJSON
 * event stream.
 *
 * 2026-08-16 重写：旧版用 `codex -q --json`（无 `exec` 子命令 —— 那会进
 * 交互 TUI / 挂死到 watchdog），且解析的是 OpenAI Responses API 的 wire
 * 格式 —— 真实 codex CLI 从不输出这些。按官方无头模式文档改为
 * `codex exec --json "<prompt>"`（stdin 也可，这里用 argv 传 prompt）。
 *
 * 2026-09-23 真机回归（Gate-RC1，codex-cli 0.156.1 实测）：文档假设与
 * 真实输出的偏差已按捕获夹具（fixtures/codex/）修正，真实形状如下：
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata ... not found. Defaulting to fallback ..."}}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":2050,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":684,"reasoning_output_tokens":0}}
 *   {"type":"error","message":"Reconnecting... 1/5 (stream disconnected ...)"}   ← 瞬态，非终态
 *   {"type":"turn.failed","error":{"message":"stream disconnected ..."}}
 *
 * 实测偏差（详见 codex.test.ts「真机 0.156.1 实测形状」组）：
 *   - item 主键字段是 `id`（`item_id` 保留为旧形状兜底）
 *   - reasoning 正文字段是 `text`（`summary` 是旧文档形状）
 *   - 顶层 error 帧 message 平铺、且存在瞬态 Reconnecting 帧（不得置 failed）
 *   - usage 含 cache_write_input_tokens / reasoning_output_tokens 附加字段
 *   - argv：`--full-auto` / `--max-turns` 已移除（见 buildCodexArgs 注释）
 *
 * 旧 Responses-API 形状作为兼容分支保留（若未来 codex 恢复该格式不会静默丢字）。
 *
 * The full lifecycle (spawn / readline / timeout / kill escalation / inactivity
 * watchdog) is delegated to `spawnStreamAgent` from `stream-backend.ts`; this
 * file contains ONLY argv construction + per-line parsing.
 */
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  BackendConfig,
  ExecOptions,
} from '@dagents/contracts'
import { filterCustomArgs, spawnStreamAgent } from './stream-backend.js'
import type { StreamAgentRunState } from './stream-backend.js'
import { accumulateUsage } from './usage.js'

// ────────────────────────────────────────────────────────────────────────────
// argv construction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Flags the daemon hardcodes and must not let a caller override via
 * extraArgs/customArgs. `exec`/`--json` define the protocol this adapter
 * parses; `--model`/`-m` and `--max-turns` are owned by ExecOptions.
 */
const CODEX_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  exec: 'standalone',
  '--json': 'standalone',
  '--experimental-json': 'standalone',
  '--model': 'value',
  '-m': 'value',
  '-s': 'value',
  '--sandbox': 'value',
  '--full-auto': 'standalone',
  '--max-turns': 'value',
}

/**
 * Build the codex CLI argv for a non-interactive `exec --json` run.
 *
 * `codex exec --json --skip-git-repo-check [-s <mode>] [--model <m>]
 *    <filtered extra/custom args> -- <prompt>`
 *
 * `--skip-git-repo-check`：codex exec 默认拒绝在非 git 目录运行；agent 的
 * cwd 不保证是仓库，跳过该检查（行为等价于在仓库内运行）。
 *
 * 2026-09-23 真机回归（codex-cli 0.156.1）argv 修正：
 *   - `--full-auto` 已从 CLI 移除（unexpected argument → exit 2）。保守
 *     全自动的语义等价物是 `-s workspace-write`（工作区可写，仍沙箱）。
 *   - `--max-turns` 已移除且无替代 flag/config（binary 零字符串命中，
 *     `-c` 试探均被 unrecognized-setting 忽略）——不生成该 flag，多轮
 *     上限交由调用方 timeoutMs / 静默看门狗兜底。
 */
export function buildCodexArgs(prompt: string, opts: ExecOptions): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  // 非交互权限（对齐 claude 的 bypassPermissions / qwen 的 --yolo）：
  // codex exec 默认 read-only 沙箱，写文件类工具全被拒 → 模型绕路后回复
  // "没权限"。默认 workspace-write = 工作区可写 + 联网，仍在沙箱内。
  // DAGENTS_CODEX_SANDBOX 可覆盖（read-only / danger-full-access / none）。
  const codexSandbox = process.env.DAGENTS_CODEX_SANDBOX ?? 'full-auto'
  if (codexSandbox !== 'none') {
    // 'full-auto' 是兼容别名（旧 DAGENTS_CODEX_SANDBOX 值），映射到现行等价档
    args.push('-s', codexSandbox === 'full-auto' ? 'workspace-write' : codexSandbox)
  }
  if (opts.model) args.push('--model', opts.model)
  args.push(...filterCustomArgs(opts.extraArgs, CODEX_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, CODEX_BLOCKED_ARGS))
  // `--` 之后是 prompt 位置参数（防止以 `-` 开头的 prompt 被当成 flag）。
  args.push('--', prompt)
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// NDJSON line types（codex-rs exec --json 事件 + 兼容旧 Responses-API 形状）
// ────────────────────────────────────────────────────────────────────────────

interface CodexItem {
  item_id?: string
  id?: string
  type?: string
  text?: string
  /** command_execution */
  command?: string
  aggregated_output?: string
  exit_code?: number
  /** file_change */
  changes?: Record<string, unknown>
  /** reasoning —— 0.156.1 实测正文字段是 text；summary 是旧文档形状 */
  summary?: string
  /** error item（如模型元数据警告）——0.156.1 实测 */
  message?: string
}

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  /** 0.156.1 实测附加字段（映射兼容，暂不采集） */
  cache_write_input_tokens?: number
  reasoning_output_tokens?: number
  output_tokens?: number
}

interface CodexLine {
  type: string
  /** thread.started */
  thread_id?: string
  /** item.* */
  item?: CodexItem
  /** turn.completed */
  usage?: CodexUsage
  /** turn.failed */
  error?: { message?: string }
  /**
   * error 顶层帧 —— 0.156.1 实测：message 直接平铺（无 error 包装对象）。
   * 瞬态重连帧形如 "Reconnecting... N/5 (...)"，最多连发 5 次，可能恢复。
   */
  message?: string
  // ── 旧 Responses-API 兼容形状 ──
  role?: string
  content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }>
  message2?: never
  model?: string
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one stdout line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse one codex NDJSON line into zero or more unified events, mutating
 * `state` for usage / output / failure tracking.
 *
 * Exported (as `parseCodexLine`) for direct unit testing.
 */
export function parseCodexLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  let msg: CodexLine
  try {
    msg = JSON.parse(line) as CodexLine
  } catch {
    return [{ type: 'log', content: line }]
  }

  const out: AgentEvent[] = []

  switch (msg.type) {
    case 'thread.started':
      if (msg.thread_id) state.sessionId = msg.thread_id
      return out

    case 'turn.started':
      return [{ type: 'status', status: 'running' }]

    case 'item.started':
      return out

    case 'item.completed': {
      const item = msg.item
      if (!item) return out
      if (item.type === 'agent_message' && item.text) {
        state.output += item.text
        out.push({ type: 'text', content: item.text })
      } else if (item.type === 'command_execution') {
        out.push({
          type: 'tool-use',
          tool: 'shell',
          callId: item.item_id ?? item.id ?? '',
          input: { command: item.command },
        })
        out.push({
          type: 'tool-result',
          tool: 'shell',
          callId: item.item_id ?? item.id ?? '',
          output: item.aggregated_output ?? `exit ${item.exit_code ?? '?'}`,
        })
      } else if (item.type === 'file_change') {
        out.push({ type: 'log', content: `file change: ${JSON.stringify(item.changes ?? {}).slice(0, 200)}` })
      } else if (item.type === 'reasoning') {
        // 0.156.1 实测：正文字段是 text；summary 是旧文档形状，保留兜底。
        const body = item.text ?? item.summary
        if (body) out.push({ type: 'log', content: body })
      } else if (item.type === 'error' && item.message) {
        // 0.156.1 实测：非致命 error item（如「Model metadata ... not
        // found. Defaulting to fallback」）——log 透出保留证据，不动终态。
        out.push({ type: 'log', content: item.message })
      }
      return out
    }

    case 'turn.completed': {
      // codex 的 usage 帧是会话累计快照（max 防重发重复计数）—— 单源见 usage.ts
      accumulateUsage(state.usage, 'codex', msg.usage, 'max')
      return out
    }

    case 'turn.failed': {
      const errMsg = msg.error?.message ?? 'codex turn failed'
      state.finalStatus = 'failed'
      state.finalError = errMsg
      out.push({ type: 'error', content: errMsg })
      return out
    }

    case 'error': {
      // 0.156.1 实测：message 平铺在顶层（无 error 包装对象）。两种帧：
      //   1. 瞬态重连 "Reconnecting... N/5 (...)" —— 最多连发 5 次，可能
      //      恢复；置 failed 会把成功运行毒化。→ log 透出（保留证据），不动终态。
      //   2. 终局帧（不带 Reconnecting 前缀，重试耗尽）→ failed。
      // 旧形状 {"error":{"message"}} 仍视为终局失败（兼容分支）。
      const errMsg = msg.message ?? msg.error?.message ?? 'codex error'
      if (errMsg.startsWith('Reconnecting')) {
        out.push({ type: 'log', content: errMsg })
        return out
      }
      state.finalStatus = 'failed'
      state.finalError = errMsg
      out.push({ type: 'error', content: errMsg })
      return out
    }

    default:
      break
  }

  // ── 旧 Responses-API 兼容分支（历史格式，真实 codex 当前不输出） ──
  if (msg.type === 'message' && msg.role === 'assistant') {
    const blocks = msg.content ?? []
    for (const block of blocks) {
      if ((block.type === 'output_text' || block.type === 'text') && block.text) {
        out.push({ type: 'text', content: block.text })
        state.output += block.text
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'tool-use',
          tool: block.name ?? '',
          callId: block.id ?? '',
          input: block.input,
        })
      }
    }
    return out
  }
  if (msg.type === 'completed') {
    accumulateUsage(state.usage, msg.model ?? 'codex', msg.usage, 'max')
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

/**
 * Codex agent backend. Spawns `codex exec --json -- <prompt>` (prompt as a
 * positional argv element after `--`) and parses the NDJSON event stream into
 * the unified `AgentEvent` stream.
 */
export function codexBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'codex'
      const args = buildCodexArgs(prompt, opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'codex',
        parseLine: parseCodexLine,
        inputMethod: 'argv', // prompt 在 argv 里（`--` 之后）
      })
    },
  }
}
