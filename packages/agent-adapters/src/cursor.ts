/**
 * Cursor Agent adapter — spawn `cursor-agent -p --output-format stream-json
 * --yolo` and parse its NDJSON event stream.
 *
 * Cursor's stream-json format is similar to Claude Code's but adds two
 * top-level event types (`thinking`, `tool_call`) that carry their own
 * `subtype` lifecycle (`delta`/`completed`, `started`/`completed`). Token
 * usage is taken exclusively from the `result` event to avoid double-counting
 * (per-message assistant usage is ignored). The prompt is delivered on stdin
 * (not argv) — `cursor-agent -p` is a boolean print-mode switch and the
 * prompt is positional; when no positional prompt is present and stdin is
 * not a TTY, the CLI reads stdin to EOF as the prompt.
 *
 * Translated from multica `cursor.go`.
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
 * multica `cursorBlockedArgs`. Overriding these would break the stream-json
 * protocol or autonomous operation.
 */
const CURSOR_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'standalone',
  '--output-format': 'value',
  '--yolo': 'standalone',
}

/**
 * Build the cursor-agent CLI argv for a one-shot stream-json run.
 *
 * `cursor-agent -p --output-format stream-json --yolo [--workspace <cwd>]
 *   [--model <m>] [--resume <id>] <filtered args>`
 *
 * NOTE: the prompt is deliberately NOT part of argv. cursor-agent's `-p` is
 * a boolean print-mode switch and the prompt is a positional argument; when
 * no positional prompt is present and stdin is not a TTY, the CLI reads
 * stdin to EOF and uses that as the prompt. We route the prompt through
 * stdin to keep user-controlled text off the command line (Windows .cmd/.ps1
 * launchers re-tokenise quoted args).
 *
 * cursor-agent CLI does not support --system-prompt or --max-turns;
 * instructions are injected via AGENTS.md / .cursor/skills/.
 */
export function buildCursorArgs(opts: ExecOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--yolo']
  if (opts.cwd) args.push('--workspace', opts.cwd)
  if (opts.model) args.push('--model', opts.model)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  args.push(...filterCustomArgs(opts.extraArgs, CURSOR_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, CURSOR_BLOCKED_ARGS))
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// stream-json message types (Cursor Agent wire format)
// ────────────────────────────────────────────────────────────────────────────

interface CursorContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface CursorAssistantMessage {
  model?: string
  content?: CursorContentBlock[]
}

/** Per-step token usage from `step_finish` events. */
interface CursorStepFinishTokens {
  input?: number
  output?: number
  cache?: { read?: number }
}

interface CursorStepFinishPart {
  tokens?: CursorStepFinishTokens
}

interface CursorTextPart {
  text?: string
}

/** Token usage from the `result` event — supports multiple shape variants. */
interface CursorResultUsage {
  // camelCase top-level (preferred)
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  // snake_case / nested variants
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cachedInputTokens?: number
}

interface CursorStreamEvent {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  // assistant
  message?: CursorAssistantMessage
  // thinking
  text?: string
  // tool_call (nested payload keyed by `<name>ToolCall`)
  tool_call?: Record<string, unknown>
  call_id?: string
  // tool_use (alternate shape)
  tool_name?: string
  tool_id?: string
  parameters?: unknown
  // tool_result (alternate shape)
  output?: string
  // result
  result?: string
  is_error?: boolean
  usage?: CursorResultUsage
  // error
  error?: string
  detail?: string
  // text / step_finish
  part?: unknown
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine helpers
// ────────────────────────────────────────────────────────────────────────────

/** Resolve the model name for usage attribution (event > configured > default). */
function cursorUsageModel(evtModel?: string, fallback?: string): string {
  const m = (evtModel ?? '').trim()
  if (m) return m
  const f = (fallback ?? '').trim()
  if (f) return f
  return 'cursor'
}

/** First non-zero of a list of optional numbers. */
function firstNonZero(...values: Array<number | undefined>): number {
  for (const v of values) if (v && v !== 0) return v
  return 0
}

/** Extract a Cursor tool call name/args/result from its nested envelope. */
function parseCursorToolCall(
  envelope: Record<string, unknown> | undefined,
  callIdFallback: string,
): { name: string; callId: string; input: unknown; result: string } {
  const out: { name: string; callId: string; input: unknown; result: string } = {
    name: '',
    callId: cursorCallID(callIdFallback),
    input: undefined,
    result: '',
  }
  if (!envelope) return out

  // toolCallId may be nested inside the envelope
  if (!out.callId) {
    const nestedId = envelope['toolCallId']
    if (typeof nestedId === 'string') out.callId = cursorCallID(nestedId)
  }

  // find the `<name>ToolCall` key
  const TOOL_CALL_SUFFIX = 'ToolCall'
  const keys = Object.keys(envelope)
    .filter((k) => k.length > TOOL_CALL_SUFFIX.length && k.endsWith(TOOL_CALL_SUFFIX))
    .sort()
  if (keys.length === 0) return out
  const key = keys[0]
  out.name = key.slice(0, key.length - TOOL_CALL_SUFFIX.length)
  const payload = envelope[key] as { args?: unknown; result?: unknown } | undefined
  if (payload && typeof payload === 'object') {
    out.input = payload.args
    if (payload.result != null) out.result = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result)
  }
  return out
}

/** Cursor packs two ids into one newline-separated string; keep the first. */
function cursorCallID(raw: string): string {
  const id = raw.trim()
  const idx = id.indexOf('\n')
  return (idx >= 0 ? id.slice(0, idx) : id).trim()
}

/** Pick the first non-empty error text from a result/error frame. */
function cursorErrorText(evt: CursorStreamEvent): string {
  if (evt.error) return evt.error
  if (evt.detail) return evt.detail
  if (evt.result) return evt.result
  return ''
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one JSONL line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

export function parseCursorLine(
  line: string,
  state: StreamAgentRunState,
  configuredModel?: string,
): AgentEvent[] {
  let evt: CursorStreamEvent
  try {
    evt = JSON.parse(line) as CursorStreamEvent
  } catch {
    return [{ type: 'log', content: line }]
  }

  const out: AgentEvent[] = []
  if (evt.session_id) state.sessionId = evt.session_id

  switch (evt.type) {
    case 'system': {
      if (evt.subtype === 'init') {
        out.push({ type: 'status', status: 'started', sessionId: state.sessionId })
      } else if (evt.subtype === 'error') {
        const errMsg = cursorErrorText(evt)
        if (errMsg) {
          state.finalStatus = 'failed'
          state.finalError = errMsg
          out.push({ type: 'error', content: errMsg })
        }
      }
      break
    }
    case 'assistant': {
      if (!evt.message) break
      for (const block of evt.message.content ?? []) {
        if ((block.type === 'output_text' || block.type === 'text') && block.text) {
          state.output += block.text
          out.push({ type: 'text', content: block.text })
        } else if (block.type === 'thinking' && block.text) {
          out.push({ type: 'thinking', content: block.text })
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'tool-use',
            tool: block.name ?? '',
            callId: block.id ?? '',
            input: block.input,
          })
        }
      }
      // NOTE: per-message usage is intentionally ignored — token usage is
      // taken exclusively from the `result` event to avoid double-counting.
      break
    }
    case 'thinking': {
      // Top-level reasoning event. Only `delta` carries content; `completed`
      // closes the block (no content).
      if (evt.subtype === 'delta' && evt.text) {
        out.push({ type: 'thinking', content: evt.text })
      }
      break
    }
    case 'tool_call': {
      // Only `started`/`completed` drive the transcript.
      if (evt.subtype === 'started') {
        const call = parseCursorToolCall(evt.tool_call, evt.call_id ?? '')
        out.push({
          type: 'tool-use',
          tool: call.name,
          callId: call.callId,
          input: call.input,
        })
      } else if (evt.subtype === 'completed') {
        const call = parseCursorToolCall(evt.tool_call, evt.call_id ?? '')
        out.push({
          type: 'tool-result',
          tool: call.name,
          callId: call.callId,
          output: call.result,
        })
      }
      break
    }
    case 'tool_use': {
      // Alternate shape: params + tool_name/tool_id
      out.push({
        type: 'tool-use',
        tool: evt.tool_name ?? '',
        callId: evt.tool_id ?? '',
        input: evt.parameters,
      })
      break
    }
    case 'tool_result': {
      out.push({
        type: 'tool-result',
        tool: '',
        callId: evt.tool_id ?? '',
        output: evt.output ?? '',
      })
      break
    }
    case 'text': {
      // Streaming text fragment.
      const part = evt.part as CursorTextPart | undefined
      if (part?.text) {
        state.output += part.text
        out.push({ type: 'text', content: part.text })
      }
      break
    }
    case 'result': {
      const isError = evt.is_error || evt.subtype === 'error'
      if (isError) {
        state.finalStatus = 'failed'
        state.finalError = cursorErrorText(evt) || 'cursor-agent returned an error result without details'
      }
      // Use result text as output only if nothing was streamed.
      if (evt.result && !state.output) {
        state.output = evt.result
        out.push({ type: 'text', content: evt.result })
      }
      // Authoritative session-total usage from the result event.
      if (evt.usage) {
        const model = cursorUsageModel(evt.model, configuredModel)
        const u = evt.usage
        const input = firstNonZero(u.inputTokens, u.input_tokens)
        const output = firstNonZero(u.outputTokens, u.output_tokens)
        const cacheRead = firstNonZero(
          u.cacheReadTokens, u.cacheReadInputTokens, u.cached_input_tokens,
          u.cache_read_input_tokens, u.cachedInputTokens,
        )
        const cacheWrite = firstNonZero(
          u.cacheWriteTokens, u.cacheCreationInputTokens,
          u.cache_creation_input_tokens,
        )
        if (input || output || cacheRead || cacheWrite) {
          state.usage[model] = {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
          }
        }
      }
      break
    }
    case 'error': {
      const errMsg = cursorErrorText(evt)
      if (errMsg) {
        state.finalStatus = 'failed'
        state.finalError = errMsg
        out.push({ type: 'error', content: errMsg })
      }
      break
    }
    case 'step_finish': {
      // Per-step token counts (used only when no result usage is emitted).
      const part = evt.part as CursorStepFinishPart | undefined
      if (part?.tokens) {
        const model = cursorUsageModel(evt.model, configuredModel)
        const u = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
        u.inputTokens += part.tokens.input ?? 0
        u.outputTokens += part.tokens.output ?? 0
        u.cacheReadTokens = (u.cacheReadTokens ?? 0) + (part.tokens.cache?.read ?? 0)
        state.usage[model] = u
      }
      break
    }
    default:
      out.push({ type: 'log', content: `cursor event: ${evt.type}` })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function cursorBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'cursor-agent'
      const args = buildCursorArgs(opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'cursor-agent',
        parseLine: (line, state) => parseCursorLine(line, state, opts.model),
        inputMethod: 'stdin', // prompt read from stdin to EOF
        stdinPayload: prompt,
      })
    },
  }
}
