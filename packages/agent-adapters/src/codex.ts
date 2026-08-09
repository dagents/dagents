/**
 * Codex adapter (MVP) — spawn `codex -q --json` and parse its NDJSON output.
 *
 * The real multica codex backend (`codex.go`, ~3000 lines) uses Codex's
 * `app-server --listen stdio://` JSON-RPC 2.0 protocol, which is far too
 * complex for this MVP (handshake, thread/start, thread/event streaming,
 * MCP config.toml injection, semantic-inactivity detection, …). This adapter
 * uses the simpler non-interactive CLI mode (`-q --json`), which emits one
 * NDJSON record per line on stdout.
 *
 * NDJSON line shapes (Codex `--json` output):
 *   - `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}`
 *   - `{"type":"message","role":"assistant","content":[{"type":"tool_use","name":"...","input":{...}}]}`
 *   - `{"type":"message","role":"tool","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}`
 *   - `{"type":"completed","usage":{"input_tokens":100,"output_tokens":50}}`
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
 * extraArgs/customArgs. `-q`/`--quiet` and `--json` define the non-interactive
 * NDJSON protocol this adapter parses; `--model` and `--max-turns` are owned
 * by ExecOptions. Mirrors the spirit of multica `codexBlockedArgs`.
 */
const CODEX_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-q': 'standalone',
  '--quiet': 'standalone',
  '--json': 'standalone',
  '--model': 'value',
  '-m': 'value',
  '--max-turns': 'value',
}

/**
 * Build the codex CLI argv for a non-interactive `--json` run.
 *
 * `codex -q --json [--model <m>] [--max-turns <n>] <filtered extra/custom args>`
 *
 * The prompt is passed via stdin (`inputMethod: 'stdin'` in `spawnStreamAgent`),
 * NOT as a trailing argv element — this keeps multi-line prompts out of the
 * process argument list (and argv-length limits).
 */
export function buildCodexArgs(opts: ExecOptions): string[] {
  const args = ['-q', '--json']
  if (opts.model) args.push('--model', opts.model)
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns))
  args.push(...filterCustomArgs(opts.extraArgs, CODEX_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, CODEX_BLOCKED_ARGS))
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// NDJSON line types (subset of the Codex `--json` wire format)
// ────────────────────────────────────────────────────────────────────────────

interface CodexContentBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface CodexMessage {
  role?: string
  content?: CodexContentBlock[]
}

interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
}

interface CodexLine {
  type: string
  role?: string
  content?: CodexContentBlock[]
  message?: CodexMessage
  usage?: CodexUsage
  /** `completed` frame may carry a model name for usage attribution. */
  model?: string
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one stdout line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse one Codex NDJSON line into zero or more unified events, mutating
 * `state` for usage / output tracking.
 *
 * Exported (as `parseCodexLine`) for direct unit testing.
 */
export function parseCodexLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  let msg: CodexLine
  try {
    msg = JSON.parse(line) as CodexLine
  } catch {
    // Non-JSON line — surface as a log event. (spawnStreamAgent already
    // handles this by catching parseLine throws, but we re-check here so the
    // exported pure function is self-contained for unit tests.)
    return [{ type: 'log', content: line }]
  }

  const out: AgentEvent[] = []

  // Assistant message: text + tool_use blocks.
  if (msg.type === 'message' && msg.role === 'assistant') {
    const blocks = msg.content ?? msg.message?.content ?? []
    for (const block of blocks) {
      if (block.type === 'output_text' && block.text) {
        out.push({ type: 'text', content: block.text })
        state.output += block.text
      } else if (block.type === 'text' && block.text) {
        // Some Codex versions use `text` instead of `output_text`.
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

  // Tool result message.
  if (msg.type === 'message' && msg.role === 'tool') {
    const blocks = msg.content ?? msg.message?.content ?? []
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        out.push({
          type: 'tool-result',
          tool: '',
          callId: block.tool_use_id ?? '',
          output: codexToolResultToString(block.content),
        })
      }
    }
    return out
  }

  // Terminal `completed` frame: authoritative usage.
  if (msg.type === 'completed') {
    const u = msg.usage
    if (u) {
      const model = msg.model ?? 'codex'
      const existing = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
      // The completed frame is authoritative; replace (not accumulate) to
      // match the CLI's final tally. Use max in case an incremental frame
      // already reported a higher value.
      existing.inputTokens = Math.max(existing.inputTokens, u.input_tokens ?? 0)
      existing.outputTokens = Math.max(existing.outputTokens, u.output_tokens ?? 0)
      state.usage[model] = existing
    }
    return out
  }

  return out
}

/** Convert a tool_result `content` (string | array | object) to a string. */
function codexToolResultToString(content: unknown): string {
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

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

/**
 * Codex agent backend. Spawns `codex -q --json`, writes the prompt to stdin,
 * and parses NDJSON output into the unified `AgentEvent` stream.
 */
export function codexBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'codex'
      const args = buildCodexArgs(opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'codex',
        parseLine: parseCodexLine,
        inputMethod: 'stdin',
        stdinPayload: prompt,
      })
    },
  }
}
