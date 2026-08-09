/**
 * Qwen Code adapter — spawn `qwen -p <prompt> --output-format stream-json`
 * and parse its NDJSON event stream.
 *
 * Qwen Code's stream-json format is nearly identical to Claude Code's (same
 * SDK family): `system`/`assistant`/`user`/`result` frames with content blocks.
 * Translated from multica `qwen.go`.
 *
 * NDJSON line shapes (Qwen Code stream-json):
 *   - `{"type":"system","subtype":"init","session_id":"..."}`
 *   - `{"type":"assistant","message":{"model":"...","content":[{"type":"text","text":"..."}]}}`
 *   - `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}`
 *   - `{"type":"result","result":"final output","session_id":"...","usage":{...}}`
 *
 * The full lifecycle is delegated to `spawnStreamAgent`.
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
 * Flags the daemon hardcodes and must not let a caller override. Qwen accepts
 * the task prompt and stream protocol as flags; model/session/yolo are also
 * daemon-owned. Mirrors multica `qwenBlockedArgs`.
 */
const QWEN_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'value',
  '--prompt': 'value',
  '-i': 'value',
  '--prompt-interactive': 'value',
  '-o': 'value',
  '--output-format': 'value',
  '-m': 'value',
  '--model': 'value',
  '-r': 'value',
  '--resume': 'value',
  '-c': 'standalone',
  '--continue': 'standalone',
  '--chat-recording': 'value',
  '--mcp-config': 'value',
  '--safe-mode': 'standalone',
  '--yolo': 'standalone',
  '-y': 'standalone',
  '--approval-mode': 'value',
  '--core-tools': 'value',
}

/**
 * Build the Qwen Code CLI argv for a non-interactive stream-json run.
 *
 * `qwen -p <prompt> --output-format stream-json [--model <m>] [--resume <id>] --yolo <filtered args>`
 *
 * The prompt is passed as an argv element (`-p <prompt>`), so the adapter uses
 * `inputMethod: 'argv'` — stdin is not written. `--yolo` enables Qwen's
 * non-interactive bypass mode (filters out approval-requiring tools otherwise).
 */
export function buildQwenArgs(prompt: string, opts: ExecOptions): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json']
  if (opts.model) args.push('--model', opts.model)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  // --yolo is daemon-owned: Qwen Code's non-interactive mode filters out
  // approval-requiring tools (run_shell_command, edit, write_file, etc.)
  // unless bypass mode is active.
  args.push('--yolo')
  args.push(...filterCustomArgs(opts.extraArgs, QWEN_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, QWEN_BLOCKED_ARGS))
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// stream-json line types (Qwen Code — same SDK family as Claude)
// ────────────────────────────────────────────────────────────────────────────

interface QwenContentBlock {
  type: string
  thinking?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface QwenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
}

interface QwenMessage {
  model?: string
  content?: QwenContentBlock[]
  usage?: QwenUsage
}

interface QwenError {
  message?: string
}

interface QwenLine {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  message?: QwenMessage
  result?: string
  is_error?: boolean
  usage?: QwenUsage
  error?: QwenError
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one stdout line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse one Qwen stream-json line into zero or more unified events, mutating
 * `state` for usage / output / session tracking.
 *
 * Exported (as `parseQwenLine`) for direct unit testing.
 */
export function parseQwenLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  let msg: QwenLine
  try {
    msg = JSON.parse(line) as QwenLine
  } catch {
    return [{ type: 'log', content: line }]
  }

  const out: AgentEvent[] = []

  // Track session id from any frame that carries it.
  if (msg.session_id) state.sessionId = msg.session_id

  // system init → status started
  if (msg.type === 'system') {
    if (msg.subtype === 'init' && msg.session_id) {
      out.push({ type: 'status', status: 'started', sessionId: msg.session_id })
    }
    return out
  }

  // assistant: text + thinking + tool_use blocks; incremental usage
  if (msg.type === 'assistant' && msg.message) {
    const model = msg.message.model ?? msg.model
    if (msg.message.usage && model) {
      const u = msg.message.usage
      const existing = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
      existing.inputTokens += u.input_tokens ?? 0
      existing.outputTokens += u.output_tokens ?? 0
      existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      state.usage[model] = existing
    }
    for (const block of msg.message.content ?? []) {
      if (block.type === 'text' && block.text) {
        out.push({ type: 'text', content: block.text })
        state.output += block.text
      } else if (block.type === 'thinking' && block.thinking) {
        out.push({ type: 'thinking', content: block.thinking })
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

  // user: tool_result blocks
  if (msg.type === 'user' && msg.message) {
    for (const block of msg.message.content ?? []) {
      if (block.type === 'tool_result') {
        out.push({
          type: 'tool-result',
          tool: '',
          callId: block.tool_use_id ?? '',
          output: qwenToolResultToString(block.content),
        })
      }
    }
    return out
  }

  // result: terminal frame — authoritative output + usage
  if (msg.type === 'result') {
    const isError = msg.is_error || msg.subtype === 'error' || msg.subtype === 'failed'
    if (isError) {
      state.finalStatus = 'failed'
      state.finalError = qwenErrorText(msg)
      if (state.finalError) state.output = state.finalError
    } else if (msg.result) {
      // Authoritative final output replaces the streamed accumulation.
      state.output = msg.result
    }
    // Usage from the result frame replaces incremental accumulation.
    if (msg.usage) {
      const model = msg.model ?? 'qwen'
      const u = msg.usage
      if ((u.input_tokens ?? 0) !== 0 || (u.output_tokens ?? 0) !== 0 || (u.cache_read_input_tokens ?? 0) !== 0) {
        state.usage[model] = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
        }
      }
    }
    if (msg.session_id) {
      out.push({ type: 'status', status: 'completed', sessionId: msg.session_id })
    }
    return out
  }

  // error event (fail-closed for future Qwen releases)
  if (msg.type === 'error') {
    state.finalStatus = 'failed'
    state.finalError = qwenErrorText(msg)
    out.push({ type: 'error', content: state.finalError ?? 'qwen error' })
    return out
  }

  return out
}

/** Convert a tool_result `content` (string | array | object) to a string. */
function qwenToolResultToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .join('')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/** Extract a human-readable error message from a result/error frame. */
function qwenErrorText(msg: QwenLine): string {
  if (msg.result) return msg.result
  if (msg.error?.message) return msg.error.message
  if (msg.error) return JSON.stringify(msg.error)
  return 'qwen returned an error event without details'
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

/**
 * Qwen Code agent backend. Spawns `qwen -p <prompt> --output-format stream-json`
 * and parses the NDJSON event stream into the unified `AgentEvent` stream.
 */
export function qwenBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'qwen'
      const args = buildQwenArgs(prompt, opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'qwen',
        parseLine: parseQwenLine,
        inputMethod: 'argv',
      })
    },
  }
}
