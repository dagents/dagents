/**
 * OpenClaw adapter — spawn `openclaw agent --message <prompt> --json
 * --session-id <id> [--local]` and parse its stdout.
 *
 * 实测（openclaw 2026.7.1，2026-08-16）：
 *   - 成功时 `--json` 输出一个 JSON 结果 blob（可能是单行，也可能
 *     pretty-printed 多行 —— `payloads[].text` + `meta.agentMeta`）。
 *   - 失败时输出**纯文本**：`[diagnostic] lane task error: …` 行 + 最终
 *     `FailoverError: …` / `ProviderAuthError: …` 行，且**退出码为 0**。
 *     因此必须靠解析错误行来判定失败，退出码不可信。
 *
 * 解析策略（见 parseOpenclawLine）：
 *   1. NDJSON 流式事件（text/tool_use/tool_result/error/lifecycle/…）。
 *   2. JSON 结果 blob —— 支持多行 pretty-printed：以 `{` 开始缓冲，逐行
 *      追加并尝试整体 JSON.parse（按 state 对象隔离，每次运行独立）。
 *   3. 纯文本错误行（FailoverError: 等已知前缀）→ 标记 failed。
 *   4. 其余 → log 事件（保留可调试性）。
 *
 * Translated from multica `openclaw.go`.
 *
 * NOTE: openclaw does NOT accept --model or --system-prompt at the CLI —
 * model is bound at agent registration (`openclaw agents add/update --model`),
 * and system instructions must be injected inline into --message (openclaw
 * loads AGENTS.md from its own workspace dir, not cwd).
 */
import { randomUUID } from 'node:crypto'
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
 * Flags the daemon hardcodes and must not let a caller override. Mirrors
 * multica `openclawBlockedArgs`.
 */
const OPENCLAW_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '--local': 'standalone',
  '--json': 'standalone',
  '--session-id': 'value',
  '--message': 'value',
  '--model': 'value',
  '--system-prompt': 'value',
}

/** True when the filtered custom args contain the given flag (standalone or =value). */
function customArgsContains(args: string[], flag: string): boolean {
  const prefix = flag + '='
  return args.some((a) => a === flag || a.startsWith(prefix))
}

/**
 * Build the openclaw CLI argv for a one-shot `openclaw agent` invocation.
 *
 * `openclaw agent [--local] --json --session-id <id> [--timeout <s>]
 *   [--agent <id>] <filtered args> --message <prompt>`
 *
 * --local is the embedded-mode opt-in (defaults to Gateway routing). Model
 * is bound at agent registration; the daemon selects one at runtime via
 * --agent <id>. system-prompt (if set) is prepended to the prompt because
 * openclaw doesn't accept --system-prompt.
 */
export function buildOpenclawArgs(prompt: string, sessionId: string, opts: ExecOptions): string[] {
  const args = ['agent', '--local', '--json', '--session-id', sessionId]
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    args.push('--timeout', String(Math.ceil(opts.timeoutMs / 1000)))
  }
  const customArgs = filterCustomArgs(opts.customArgs, OPENCLAW_BLOCKED_ARGS)
  // opts.model is an agent id (not a real model); inject --agent only when
  // the user hasn't already set it via custom_args.
  if (opts.model && !customArgsContains(customArgs, '--agent')) {
    args.push('--agent', opts.model)
  }
  args.push(...customArgs)
  args.push(...filterCustomArgs(opts.extraArgs, OPENCLAW_BLOCKED_ARGS))
  // system-prompt is injected inline into --message (openclaw doesn't accept
  // --system-prompt).
  const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt
  args.push('--message', fullPrompt)
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// stdout types (OpenClaw JSON output)
// ────────────────────────────────────────────────────────────────────────────

/** Streaming NDJSON event (forward-compat; openclaw 2026.5.x doesn't emit these). */
interface OpenclawEvent {
  type: string
  sessionId?: string
  text?: string
  tool?: string
  callId?: string
  input?: unknown
  usage?: Record<string, unknown>
  phase?: string
  error?: { name?: string; data?: { message?: string }; message?: string }
  message?: string
}

/** Final result blob (the legacy single-blob format with payloads + meta). */
interface OpenclawResult {
  payloads?: Array<{ text?: string }>
  meta?: {
    durationMs?: number
    agentMeta?: Record<string, unknown>
  }
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine helpers
// ────────────────────────────────────────────────────────────────────────────

/** Extract a human-readable error message from an openclaw event. */
function openclawErrorMessage(evt: OpenclawEvent): string {
  if (evt.error) {
    if (evt.error.data?.message) return evt.error.data.message
    if (evt.error.message) return evt.error.message
    if (evt.error.name) return evt.error.name
  }
  if (evt.text) return evt.text
  if (evt.message) return evt.message
  return 'unknown openclaw error'
}

/** Safely extract an integer from a JSON-decoded map value. */
function openclawInt64(data: Record<string, unknown>, key: string): number {
  const v = data[key]
  if (typeof v === 'number') return v
  return 0
}

/** First non-zero integer found under any of the given keys. */
function openclawInt64FirstOf(data: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const v = openclawInt64(data, key)
    if (v !== 0) return v
  }
  return 0
}

/** Parse token usage from a map (supports multiple field-name conventions). */
function parseOpenclawUsage(data: Record<string, unknown>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
} {
  return {
    inputTokens: openclawInt64FirstOf(data, ['input', 'inputTokens', 'input_tokens']),
    outputTokens: openclawInt64FirstOf(data, ['output', 'outputTokens', 'output_tokens']),
    cacheReadTokens: openclawInt64FirstOf(data, [
      'cacheRead', 'cachedInputTokens', 'cached_input_tokens', 'cache_read', 'cache_read_input_tokens',
    ]),
    cacheWriteTokens: openclawInt64FirstOf(data, [
      'cacheWrite', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cache_write',
    ]),
  }
}

/** Extract events from a final result blob, appending text to state.output. */
function emitOpenclawResult(
  result: OpenclawResult,
  state: StreamAgentRunState,
): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const p of result.payloads ?? []) {
    if (p.text) {
      state.output += p.text
      out.push({ type: 'text', content: p.text })
    }
  }
  if (result.meta?.agentMeta) {
    const am = result.meta.agentMeta
    const sid = am['sessionId']
    if (typeof sid === 'string') state.sessionId = sid
    const usage = am['usage']
    if (usage && typeof usage === 'object') {
      const u = parseOpenclawUsage(usage as Record<string, unknown>)
      const model = typeof am['model'] === 'string' ? (am['model'] as string).trim() : 'unknown'
      state.usage[model] = u
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure-ish: one stdout line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-run buffer for pretty-printed (multi-line) JSON blobs, keyed by the
 * run's state object identity (spawnStreamAgent allocates one per run).
 */
const jsonBuffers = new WeakMap<StreamAgentRunState, string[]>()

/** 已知的 openclaw 纯文本错误行前缀（失败时 CLI 打印这些且退出码仍为 0）。 */
const OPENCLAW_ERROR_LINE_RE =
  /^(FailoverError|ProviderAuthError|GatewayCredentialsRequiredError|GatewayError|ConfigError|Error):/

/** Max bytes to buffer while waiting for a pretty-printed JSON blob to complete. */
const MAX_JSON_BUFFER_CHARS = 1_000_000

/**
 * Try to parse one openclaw stdout line. Handles four cases:
 *   1. Streaming NDJSON event（type 字段）— 直接产出事件。
 *   2. JSON 结果 blob（payloads 或 meta.durationMs）— 提取 text/usage/
 *      session id。支持多行 pretty-printed：`{` 起缓冲，逐行追加尝试整体解析。
 *   3. 纯文本错误行（FailoverError: 等已知前缀）→ 标记 failed（openclaw
 *      失败时退出码是 0，只能靠这里判定）。
 *   4. 其余 → log 事件。
 *
 * Exported as `parseOpenclawLine` for direct unit testing.
 */
export function parseOpenclawLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  const trimmed = line.trim()

  // [diagnostic] 行保留为 log（往往是错误的第一现场，但不作为终止依据）。
  if (trimmed.startsWith('[diagnostic]')) {
    return [{ type: 'log', content: trimmed }]
  }

  // 纯文本错误行 —— openclaw 失败路径（退出码 0），必须显式判失败。
  if (OPENCLAW_ERROR_LINE_RE.test(trimmed)) {
    state.finalStatus = 'failed'
    state.finalError = trimmed
    return [{ type: 'error', content: trimmed }]
  }

  // 多行 JSON 缓冲：已经在攒一个 blob，或本行开启一个新 blob。
  const buf = jsonBuffers.get(state)
  if (buf && buf.length > 0) {
    buf.push(line)
    const joined = buf.join('\n')
    if (joined.length > MAX_JSON_BUFFER_CHARS) {
      jsonBuffers.set(state, [])
      return [{ type: 'log', content: `openclaw: unparsable JSON blob (${joined.length} chars)` }]
    }
    try {
      const parsed = JSON.parse(joined) as unknown
      jsonBuffers.set(state, [])
      return handleParsedJson(parsed, state)
    } catch {
      return [] // blob 还没闭合，继续缓冲
    }
  }

  // Fast path: a standalone JSON object line.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return handleParsedJson(parsed, state)
    } catch {
      // 不完整 —— 进入多行缓冲模式。
      jsonBuffers.set(state, [line])
      return []
    }
  }

  // Not JSON at all — surface as a log line.
  return [{ type: 'log', content: line }]
}

/** A parsed JSON object (event or result blob) → AgentEvent[]. */
function handleParsedJson(parsed: unknown, state: StreamAgentRunState): AgentEvent[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return []
  }
  const obj = parsed as Record<string, unknown>

  // Final result blob?
  const asResult = obj as OpenclawResult
  if (asResult.payloads !== undefined || asResult.meta?.durationMs !== undefined) {
    return emitOpenclawResult(asResult, state)
  }

  // Streaming NDJSON event?
  const evt = obj as unknown as OpenclawEvent
  if (evt.type) {
    const out: AgentEvent[] = []
    if (evt.sessionId) state.sessionId = evt.sessionId
    switch (evt.type) {
      case 'text':
        if (evt.text) {
          state.output += evt.text
          out.push({ type: 'text', content: evt.text })
        }
        break
      case 'tool_use':
        out.push({
          type: 'tool-use',
          tool: evt.tool ?? '',
          callId: evt.callId ?? '',
          input: evt.input,
        })
        break
      case 'tool_result':
        out.push({
          type: 'tool-result',
          tool: evt.tool ?? '',
          callId: evt.callId ?? '',
          output: evt.text ?? '',
        })
        break
      case 'error': {
        const errMsg = openclawErrorMessage(evt)
        state.finalStatus = 'failed'
        state.finalError = errMsg
        out.push({ type: 'error', content: errMsg })
        break
      }
      case 'lifecycle': {
        if (evt.phase === 'error' || evt.phase === 'failed' || evt.phase === 'cancelled') {
          const errMsg = openclawErrorMessage(evt)
          state.finalStatus = 'failed'
          state.finalError = errMsg
          out.push({ type: 'error', content: errMsg })
        }
        break
      }
      case 'step_start':
        out.push({ type: 'status', status: 'running' })
        break
      case 'step_finish':
        if (evt.usage) {
          const u = parseOpenclawUsage(evt.usage)
          const model = 'openclaw'
          const existing = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
          existing.inputTokens += u.inputTokens
          existing.outputTokens += u.outputTokens
          existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + u.cacheReadTokens
          existing.cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + u.cacheWriteTokens
          state.usage[model] = existing
        }
        break
      default:
        out.push({ type: 'log', content: `openclaw event: ${evt.type}` })
    }
    return out
  }

  // JSON 但既非事件也非结果 blob —— 记 log。
  return [{ type: 'log', content: JSON.stringify(obj).slice(0, 200) }]
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function openclawBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'openclaw'
      // Session id: reuse the provided one, or generate a fresh random id
      // （`dagents-${Date.now()}` 同毫秒并发会撞 id）。
      const sessionId = opts.resumeSessionId || `dagents-${randomUUID()}`
      const args = buildOpenclawArgs(prompt, sessionId, opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'openclaw',
        parseLine: parseOpenclawLine,
        inputMethod: 'argv', // prompt is already in args (--message)
      })
    },
  }
}
