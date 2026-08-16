/**
 * Pi adapter — spawn `pi -p --mode json --session <path> <prompt>` and
 * parse its NDJSON event stream on stdout.
 *
 * Pi's JSON event types:
 *   - agent_start      → status running
 *   - turn_start       → reset accumulated text for a new turn
 *   - message_update   → text_delta / thinking_delta (with tool-call markup
 *                         sanitization — Pi interleaves control tokens like
 *                         `<|tool_call|>` and `call:Name{...}` into the text
 *                         stream; we strip them so the user sees clean prose)
 *   - tool_execution_start → tool-use event
 *   - tool_execution_end   → tool-result event
 *   - turn_end         → per-turn token usage (message.usage)
 *   - error            → error event
 *   - auto_retry_end   → terminal retry failure
 *
 * The prompt is a positional argument (last in argv). Pi's `--session` flag
 * expects a file path where events are appended; the path doubles as the
 * opaque session identifier (returned as sessionId, passed back as
 * resumeSessionId).
 *
 * Translated from multica `pi.go`.
 *
 * NOTE: multica's full text-sanitization state machine (drainPiSanitizedText,
 * scanPiToolMarkupEnd, etc.) is complex and handles partial fragments across
 * deltas. This MVP adapter uses a simpler regex-based strip that handles
 * the common complete-fragment case; a follow-up can port the full state
 * machine if delta-boundary markup leakage is observed in practice.
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
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ────────────────────────────────────────────────────────────────────────────
// argv construction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Flags the daemon hardcodes and must not let a caller override. Mirrors
 * multica `piBlockedArgs`. Overriding these would break the daemon↔Pi
 * communication protocol.
 */
const PI_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'standalone',
  '--print': 'standalone',
  '--mode': 'value',
  '--session': 'value',
}

/** Parse a "provider/model" string into its parts; plain strings pass through. */
function splitPiModel(s: string): { provider: string; model: string } {
  const trimmed = s.trim()
  const i = trimmed.indexOf('/')
  if (i >= 0) {
    return {
      provider: trimmed.slice(0, i).trim(),
      model: trimmed.slice(i + 1).trim(),
    }
  }
  return { provider: '', model: trimmed }
}

/**
 * Build the Pi CLI argv for a one-shot invocation.
 *
 * `-p --mode json --session <path> [--provider <p>] [--model <m>]
 *   [--append-system-prompt <s>] <filtered args> <prompt>`
 *
 * The prompt is a positional argument and must be last. `--tools` is
 * intentionally NOT passed so Pi uses its full tool registry (including
 * user-installed extension tools).
 */
export function buildPiArgs(prompt: string, sessionPath: string, opts: ExecOptions): string[] {
  const args = ['-p', '--mode', 'json']
  if (sessionPath) args.push('--session', sessionPath)
  if (opts.model) {
    const { provider, model } = splitPiModel(opts.model)
    if (provider) args.push('--provider', provider)
    if (model) args.push('--model', model)
  }
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  args.push(...filterCustomArgs(opts.extraArgs, PI_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, PI_BLOCKED_ARGS))
  args.push(prompt)
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// session path management
// ────────────────────────────────────────────────────────────────────────────

/** Directory where Pi session JSONL files live. */
function piSessionDir(): string {
  const home = os.homedir()
  return path.join(home, '.dagents', 'pi-sessions')
}

/** Create a fresh session file path (timestamped). */
function newPiSessionPath(): string {
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  return path.join(piSessionDir(), name)
}

/**
 * Resolve a caller-provided session id to a path inside the pi session dir.
 * `resumeSessionId` is untrusted input — using it verbatim as a filesystem
 * path would let a caller create/touch arbitrary files (mkdir -p + append).
 * Contain it: take the basename (drops any directory component), sanitize the
 * characters, and re-root it under piSessionDir().
 */
function resolveResumeSessionPath(sessionId: string): string {
  const base = path.basename(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
  if (!base || base === '.' || base === '..') return newPiSessionPath()
  const name = base.endsWith('.jsonl') ? base : `${base}.jsonl`
  return path.join(piSessionDir(), name)
}

/** Ensure the session file exists (Pi refuses to start on a missing --session path). */
function ensurePiSessionFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // Create the file if it doesn't exist; leave existing files untouched.
  const fd = fs.openSync(filePath, 'a')
  fs.closeSync(fd)
}

// ────────────────────────────────────────────────────────────────────────────
// Pi event types
// ────────────────────────────────────────────────────────────────────────────

interface PiAssistantMessageEvent {
  type: string // "text_delta" | "thinking_delta"
  delta?: string
}

interface PiUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
}

interface PiMessage {
  role?: string
  model?: string
  usage?: PiUsage
}

interface PiStreamEvent {
  type: string
  // message_update
  assistantMessageEvent?: PiAssistantMessageEvent
  // tool_execution_start / tool_execution_end
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  // error: message is a string; turn_end: message is an object
  message?: unknown
  // auto_retry_end
  success?: boolean
  finalError?: string
}

// ────────────────────────────────────────────────────────────────────────────
// text sanitization (strip Pi's interleaved tool-call markup)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Regex matching Pi control tokens like `<|tool_call|>`, `<|end|>`,
 * `<|\"|>` (the quote-escape marker Pi uses inside tool-call JSON).
 */
const PI_CONTROL_TOKEN_RE = /<\|[A-Za-z0-9_-]+>[A-Za-z0-9_-]*|<[A-Za-z0-9_-]+\|>/g

/**
 * Regex matching Pi's structured tool-call markup: `call:Name{...}` and
 * `response:Name{...}` blocks. We match the prefix + name + brace-balanced
 * body conservatively (non-greedy to the closing brace). This is simpler
 * than multica's char-by-char scanner but handles the common complete-fragment
 * case; a follow-up can port the full state machine if delta-boundary markup
 * leakage is observed.
 */
const PI_TOOL_CALL_PREFIXES = ['call:', 'response:']

/** Strip control tokens and structured tool-call markup from a text fragment. */
function stripPiToolCallMarkup(s: string): string {
  // Remove control tokens first.
  let out = s.replace(PI_CONTROL_TOKEN_RE, '')
  // Remove `call:Name{...}` and `response:Name{...}` blocks. We do a
  // best-effort brace-balanced match; if the braces don't balance (partial
  // fragment), leave the text as-is rather than corrupt it.
  for (const prefix of PI_TOOL_CALL_PREFIXES) {
    let idx = out.indexOf(prefix)
    while (idx >= 0) {
      const nameStart = idx + prefix.length
      let i = nameStart
      while (i < out.length && /[A-Za-z0-9_-]/.test(out[i])) i++
      if (i >= out.length || out[i] !== '{') {
        // Not a tool-call block (no brace after the name); skip this prefix.
        idx = out.indexOf(prefix, idx + 1)
        continue
      }
      // Scan for the matching close brace, respecting Pi's `<|"|>` quote marker.
      let depth = 0
      let inQuote = false
      let end = -1
      const QUOTE_MARKER = '<|"|>'
      while (i < out.length) {
        if (out.startsWith(QUOTE_MARKER, i)) {
          inQuote = !inQuote
          i += QUOTE_MARKER.length
          continue
        }
        if (!inQuote) {
          if (out[i] === '{') depth++
          else if (out[i] === '}') {
            depth--
            if (depth === 0) {
              end = i + 1
              // Optional trailing `<tool_call|>` marker.
              const TRAILER = '<tool_call|>'
              if (out.startsWith(TRAILER, end)) end += TRAILER.length
              break
            }
          }
        }
        i++
      }
      if (end < 0) {
        // Unbalanced — leave the rest as-is to avoid data loss.
        break
      }
      out = out.slice(0, idx) + out.slice(end)
      idx = out.indexOf(prefix, idx)
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one JSONL line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/** Decode a turn_end message (object) into a PiMessage; null on failure. */
function decodePiMessage(raw: unknown): PiMessage | null {
  if (!raw || typeof raw !== 'object') return null
  return raw as PiMessage
}

/** Decode an error message field (string or JSON-encoded string). */
function decodePiString(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/** Decode a tool result (string passthrough or JSON-stringify). */
function decodePiResult(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/**
 * Parse one Pi NDJSON line into zero or more unified events, mutating
 * `state` for usage / output / session tracking. Text deltas are sanitized
 * to strip Pi's interleaved tool-call markup.
 *
 * Exported as `parsePiLine` for direct unit testing.
 */
export function parsePiLine(
  line: string,
  state: StreamAgentRunState,
  configuredModel?: string,
): AgentEvent[] {
  let evt: PiStreamEvent
  try {
    evt = JSON.parse(line) as PiStreamEvent
  } catch {
    return [{ type: 'log', content: line }]
  }

  const out: AgentEvent[] = []

  switch (evt.type) {
    case 'agent_start':
      out.push({ type: 'status', status: 'running' })
      break
    case 'turn_start':
      // Reset accumulated output for a new turn (each turn is a fresh reply).
      state.output = ''
      break
    case 'message_update': {
      const am = evt.assistantMessageEvent
      if (!am) break
      if (am.type === 'text_delta' && am.delta) {
        const sanitized = stripPiToolCallMarkup(am.delta)
        if (sanitized) {
          state.output += sanitized
          out.push({ type: 'text', content: sanitized })
        }
      } else if (am.type === 'thinking_delta' && am.delta) {
        out.push({ type: 'thinking', content: am.delta })
      }
      break
    }
    case 'tool_execution_start': {
      let params: unknown
      if (evt.args && typeof evt.args === 'string') {
        try { params = JSON.parse(evt.args) } catch { params = evt.args }
      } else {
        params = evt.args
      }
      out.push({
        type: 'tool-use',
        tool: evt.toolName ?? '',
        callId: evt.toolCallId ?? '',
        input: params,
      })
      break
    }
    case 'tool_execution_end':
      out.push({
        type: 'tool-result',
        tool: '',
        callId: evt.toolCallId ?? '',
        output: decodePiResult(evt.result),
      })
      break
    case 'turn_end': {
      const msg = decodePiMessage(evt.message)
      if (msg?.usage) {
        let model = msg.model ?? configuredModel ?? 'unknown'
        if (!model) model = 'unknown'
        const u = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
        u.inputTokens += msg.usage.input ?? 0
        u.outputTokens += msg.usage.output ?? 0
        u.cacheReadTokens = (u.cacheReadTokens ?? 0) + (msg.usage.cacheRead ?? 0)
        u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + (msg.usage.cacheWrite ?? 0)
        state.usage[model] = u
      }
      break
    }
    case 'error': {
      const errText = decodePiString(evt.message) || 'pi error'
      state.finalStatus = 'failed'
      state.finalError = errText
      out.push({ type: 'error', content: errText })
      break
    }
    case 'auto_retry_end': {
      if (!evt.success && state.finalStatus === 'completed') {
        state.finalStatus = 'failed'
        state.finalError = evt.finalError || 'pi exhausted automatic retries'
      }
      break
    }
    default:
      out.push({ type: 'log', content: `pi event: ${evt.type}` })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function piBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'pi'
      // Session path: reuse the provided one, or create a fresh session file.
      // Caller-provided ids are contained under the session dir (see
      // resolveResumeSessionPath) — never used as a raw filesystem path.
      const sessionPath = opts.resumeSessionId
        ? resolveResumeSessionPath(opts.resumeSessionId)
        : newPiSessionPath()
      try {
        ensurePiSessionFile(sessionPath)
      } catch (e) {
        // Non-fatal: if we can't create the session file, let Pi handle it.
      }
      const args = buildPiArgs(prompt, sessionPath, opts)
      const session = spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'pi',
        parseLine: (line, state) => parsePiLine(line, state, opts.model),
        inputMethod: 'argv', // prompt is positional, already in args
      })
      // Override sessionId in the result with the session path (Pi's session
      // identifier is the file path, not anything the CLI emits on stdout).
      const result = session.result.then((res) => ({
        ...res,
        sessionId: sessionPath,
      }))
      return { events: session.events, result }
    },
  }
}
