/**
 * OpenCode adapter — spawn `opencode run --format json <prompt>` and parse
 * its NDJSON event stream.
 *
 * OpenCode's JSON event format is simple (flat type-tagged objects):
 *   - `{"type":"text","content":"..."}`
 *   - `{"type":"tool_use","tool":"...","input":{...}}`
 *   - `{"type":"tool_result","tool":"...","output":"..."}`
 *   - `{"type":"thinking","content":"..."}`
 *   - `{"type":"result","output":"...","session_id":"...","usage":{...}}`
 *
 * Translated from multica `opencode.go`.
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

const OPENCODE_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '--format': 'value',
  '--dir': 'value',
  '--variant': 'value',
  '--dangerously-skip-permissions': 'standalone',
  '--model': 'value',
  '--session': 'value',
}

export function buildOpencodeArgs(prompt: string, opts: ExecOptions): string[] {
  const args = ['run', '--format', 'json', '--dangerously-skip-permissions']
  if (opts.cwd) args.push('--dir', opts.cwd)
  if (opts.model) args.push('--model', opts.model)
  if (opts.thinkingLevel) args.push('--variant', opts.thinkingLevel)
  if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId)
  args.push(...filterCustomArgs(opts.extraArgs, OPENCODE_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, OPENCODE_BLOCKED_ARGS))
  args.push(prompt)
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// stream-json message types
// ────────────────────────────────────────────────────────────────────────────

interface OpencodeMessage {
  type: string
  content?: string
  tool?: string
  input?: unknown
  output?: string
  session_id?: string
  usage?: { inputTokens?: number; outputTokens?: number; model?: string }
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one JSONL line → AgentEvent[]
// ────────────────────────────────────────────────────────────────────────────

export function parseOpencodeLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  const out: AgentEvent[] = []
  let msg: OpencodeMessage
  try {
    msg = JSON.parse(line) as OpencodeMessage
  } catch {
    out.push({ type: 'log', content: line })
    return out
  }

  switch (msg.type) {
    case 'text':
      if (msg.content) {
        state.output += msg.content
        out.push({ type: 'text', content: msg.content })
      }
      break
    case 'thinking':
      if (msg.content) out.push({ type: 'thinking', content: msg.content })
      break
    case 'tool_use':
      out.push({
        type: 'tool-use',
        tool: msg.tool ?? '',
        callId: '',
        input: msg.input,
      })
      break
    case 'tool_result':
      out.push({
        type: 'tool-result',
        tool: msg.tool ?? '',
        callId: '',
        output: msg.output ?? '',
      })
      break
    case 'result':
      if (msg.session_id) state.sessionId = msg.session_id
      if (msg.content) state.output = msg.content
      if (msg.usage) {
        const model = msg.usage.model || 'opencode'
        state.usage[model] = {
          inputTokens: msg.usage.inputTokens ?? 0,
          outputTokens: msg.usage.outputTokens ?? 0,
        }
      }
      if (state.sessionId) {
        out.push({ type: 'status', status: 'completed', sessionId: state.sessionId })
      }
      break
    default:
      out.push({ type: 'log', content: `opencode event: ${msg.type}` })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function opencodeBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'opencode'
      const args = buildOpencodeArgs(prompt, opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'opencode',
        parseLine: parseOpencodeLine,
        inputMethod: 'argv', // prompt is already in args
      })
    },
  }
}
