/**
 * Codex adapter — spawn `codex exec --json "<prompt>"` and parse its NDJSON
 * event stream.
 *
 * 2026-08-16 重写：旧版用 `codex -q --json`（无 `exec` 子命令 —— 那会进
 * 交互 TUI / 挂死到 watchdog），且解析的是 OpenAI Responses API 的 wire
 * 格式（`{"type":"message","role":"assistant",...}` / `{"type":"completed"}`）
 * —— 真实 codex CLI 从不输出这些。按官方无头模式文档改为
 * `codex exec --json "<prompt>"`（stdin 也可，这里用 argv 传 prompt），解析
 * codex-rs 的实验性 JSONL 事件：
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{...}}
 *   {"type":"item.completed","item":{"item_id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"type":"command_execution","command":"...","aggregated_output":"...","exit_code":0}}
 *   {"type":"item.completed","item":{"type":"file_change","changes":{...}}}
 *   {"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":50}}
 *   {"type":"turn.failed","error":{"message":"..."}}
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
  '--max-turns': 'value',
}

/**
 * Build the codex CLI argv for a non-interactive `exec --json` run.
 *
 * `codex exec --json [--skip-git-repo-check] [--model <m>] [--max-turns <n>]
 *    <filtered extra/custom args> -- <prompt>`
 *
 * `--skip-git-repo-check`：codex exec 默认拒绝在非 git 目录运行；agent 的
 * cwd 不保证是仓库，跳过该检查（行为等价于在仓库内运行）。
 */
export function buildCodexArgs(prompt: string, opts: ExecOptions): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  // 非交互权限（对齐 claude 的 bypassPermissions / qwen 的 --yolo）：
  // codex exec 默认 read-only 沙箱，写文件类工具全被拒 → 模型绕路后回复
  // "没权限"。--full-auto = 工作区可写 + 联网，仍在沙箱内（保守的全自动）。
  // DAGENTS_CODEX_SANDBOX 可覆盖（如 danger-full-access / read-only / none）。
  const codexSandbox = process.env.DAGENTS_CODEX_SANDBOX ?? 'full-auto'
  if (codexSandbox === 'full-auto') args.push('--full-auto')
  else if (codexSandbox !== 'none') args.push('--sandbox', codexSandbox)
  if (opts.model) args.push('--model', opts.model)
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns))
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
  /** reasoning */
  summary?: string
}

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
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
  // ── 旧 Responses-API 兼容形状 ──
  role?: string
  content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }>
  message?: { role?: string; content?: CodexLine['content'] }
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
      } else if (item.type === 'reasoning' && item.summary) {
        out.push({ type: 'log', content: item.summary })
      }
      return out
    }

    case 'turn.completed': {
      const u = msg.usage
      if (u) {
        const model = 'codex'
        const existing = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
        existing.inputTokens = Math.max(existing.inputTokens, u.input_tokens ?? 0)
        existing.outputTokens = Math.max(existing.outputTokens, u.output_tokens ?? 0)
        existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (u.cached_input_tokens ?? 0)
        state.usage[model] = existing
      }
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
      const errMsg = (msg.error as { message?: string } | undefined)?.message ?? 'codex error'
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
    const blocks = msg.content ?? msg.message?.content ?? []
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
    const u = msg.usage
    if (u) {
      const model = msg.model ?? 'codex'
      const existing = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
      existing.inputTokens = Math.max(existing.inputTokens, u.input_tokens ?? 0)
      existing.outputTokens = Math.max(existing.outputTokens, u.output_tokens ?? 0)
      state.usage[model] = existing
    }
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
