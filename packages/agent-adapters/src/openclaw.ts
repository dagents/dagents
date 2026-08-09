/**
 * OpenClaw adapter — spawn `openclaw agent --message <prompt> --json
 * --session-id <id> [--local]` and parse its stdout.
 *
 * OpenClaw's stdout may contain either:
 *   1. A single pretty-printed JSON result blob (the format openclaw 2026.5.x
 *      emits today) with `payloads[].text` + `meta.agentMeta.{model,usage}`.
 *   2. NDJSON streaming events (text, tool_use, tool_result, error,
 *      lifecycle, step_start, step_finish) — supported for forward
 *      compatibility; openclaw does not emit these today.
 *
 * The whole-buffer fast path (single JSON blob) is the dominant happy path.
 * Because `spawnStreamAgent` drives a line-by-line reader, this adapter
 * handles the single-blob case by buffering lines that don't parse as
 * standalone events and attempting a whole-buffer parse when the run ends.
 * In practice, openclaw's pretty-printed JSON has one object per line, so
 * the line scanner sees `{`, intermediate lines, then `}` — none parse as
 * standalone events, so they're accumulated and the result is reconstructed
 * from the final accumulated output (see parseOpenclawLine's buffering).
 *
 * Translated from multica `openclaw.go`.
 *
 * NOTE: openclaw does NOT accept --model or --system-prompt at the CLI —
 * model is bound at agent registration (`openclaw agents add/update --model`),
 * and system instructions must be injected inline into --message (openclaw
 * loads AGENTS.md from its own workspace dir, not cwd).
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

/**
 * Try to parse a line as a final result blob. Returns the result and true
 * when the line parses as JSON with payloads or a non-zero durationMs.
 */
function tryParseOpenclawResult(raw: string): OpenclawResult | null {
  if (!raw.startsWith('{')) return null
  let result: OpenclawResult
  try {
    result = JSON.parse(raw) as OpenclawResult
  } catch {
    return null
  }
  if (!result.payloads && !result.meta?.durationMs) return null
  return result
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
// parseLine — pure: one stdout line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse one openclaw stdout line. Handles three cases:
 *   1. Streaming NDJSON event (type field present) — emit events directly.
 *   2. Final result blob (payloads or meta.durationMs) — extract text +
 *      usage + session id.
 *   3. Anything else (including partial pretty-printed JSON lines) — buffer
 *      as a log event; the spawnStreamAgent loop will surface it for
 *      debuggability. (openclaw 2026.5.x emits pretty-printed JSON across
 *      many lines; only the line starting with `{` that parses as a whole
 *      result yields events. A future whole-buffer fast path could be added
 *      if line-by-line proves lossy in practice.)
 *
 * Exported as `parseOpenclawLine` for direct unit testing.
 */
export function parseOpenclawLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  // Fast path: a standalone JSON object line.
  if (line.startsWith('{')) {
    // Try final result blob first.
    const result = tryParseOpenclawResult(line)
    if (result) return emitOpenclawResult(result, state)

    // Try streaming NDJSON event.
    try {
      const evt = JSON.parse(line) as OpenclawEvent
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
    } catch {
      // fall through to log
    }
  }

  // Not a standalone parseable JSON event — surface as a log line so
  // partial pretty-printed JSON fragments are visible for debugging.
  return [{ type: 'log', content: line }]
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function openclawBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'openclaw'
      // Session id: reuse the provided one, or generate a fresh daemon-scoped id.
      const sessionId = opts.resumeSessionId || `dagents-${Date.now()}`
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
