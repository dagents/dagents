/**
 * Google Antigravity adapter — spawn `agy -p <prompt>
 * --dangerously-skip-permissions` and stream its plain-text stdout.
 *
 * Unlike Claude / Codex / Cursor, the Antigravity CLI does NOT expose a
 * structured event stream. Stdout is plain assistant text (intermediate
 * "I will run X" lines and the final reply, all interleaved). The adapter
 * therefore streams stdout line-by-line as `text` events and accumulates
 * the same text as the final output.
 *
 * Session resumption uses `--conversation <id>`; the conversation id is not
 * emitted on stdout (multica captures it via `--log-file` glog scanning,
 * which is beyond this MVP adapter's scope — sessionId stays undefined and
 * resume is not wired until the log-scanning helper lands).
 *
 * Translated from multica `antigravity.go`.
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
 * multica `antigravityBlockedArgs`. Overriding any of these breaks
 * non-interactive operation or the daemon's session-resume bookkeeping.
 */
const ANTIGRAVITY_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'value',
  '--print': 'value',
  '--prompt': 'value',
  '-i': 'standalone',
  '--prompt-interactive': 'standalone',
  '-c': 'standalone',
  '--continue': 'standalone',
  '--conversation': 'value',
  '--model': 'value',
  '--print-timeout': 'value',
  '--dangerously-skip-permissions': 'standalone',
  '--log-file': 'value',
  '--settings': 'value',
}

/**
 * Build the agy CLI argv for a daemon-compatible one-shot invocation.
 *
 * `agy -p <prompt> --dangerously-skip-permissions [--model <m>] <filtered args>`
 *
 * agy does not expose `--system-prompt`; runtime instructions are delivered
 * via AGENTS.md in the task workdir.
 */
export function buildAntigravityArgs(prompt: string, opts: ExecOptions): string[] {
  const args = ['-p', prompt, '--dangerously-skip-permissions']
  if (opts.model) args.push('--model', opts.model)
  if (opts.resumeSessionId) args.push('--conversation', opts.resumeSessionId)
  if (opts.cwd) args.push('--add-dir', opts.cwd)
  args.push(...filterCustomArgs(opts.extraArgs, ANTIGRAVITY_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, ANTIGRAVITY_BLOCKED_ARGS))
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — plain text stdout; each line → text event
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse one stdout line into a `text` event. Antigravity emits no structured
 * events — every non-empty line is assistant narration or final reply text.
 * The accumulated text becomes `state.output`.
 */
export function parseAntigravityLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  if (state.output.length > 0) state.output += '\n'
  state.output += line
  // Only emit non-empty (trimmed) lines as text events so blank separators
  // don't surface as empty deltas.
  if (line.trim()) {
    return [{ type: 'text', content: line }]
  }
  return []
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function antigravityBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'agy'
      const args = buildAntigravityArgs(prompt, opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'agy',
        parseLine: parseAntigravityLine,
        inputMethod: 'argv', // prompt is already in args
      })
    },
  }
}
