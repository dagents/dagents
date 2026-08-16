/**
 * DevEco Code adapter — spawn `deveco run --format json
 * --dangerously-skip-permissions <prompt>` and parse its NDJSON event stream.
 *
 * DevEco Code (the `deveco` CLI, Huawei's HarmonyOS coding-agent CLI) is a
 * separate product built on the OpenCode engine. It speaks the same
 * `run --format json` protocol and emits the same NDJSON event stream as
 * upstream OpenCode, BUT with a different event schema: events carry a
 * `part` field (not a flat top-level shape), tool calls/results are paired
 * in a single `tool_use` event (state.status == "completed"), and usage
 * arrives on `step_finish` events.
 *
 * Translated from multica `deveco.go`. Deliberately self-contained (not
 * sharing code with opencode.ts) per the multica backend's design comment:
 * the two backends are independent products and must never affect each other.
 *
 * Two deliberate differences from multica (per the upstream comment):
 *   1. No `--prompt` flag — DevEco's `run` subcommand does not expose it;
 *      the prompt is a positional argument. System context is delivered via
 *      the per-task AGENTS.md the daemon writes.
 *   2. No inline MCP injection — DevEco reads MCP from DEVECO_CONFIG_CONTENT,
 *      but plumbing agent.mcp_config through it is deferred.
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
 * multica `devecoBlockedArgs`. DevEco's `run` subcommand exposes the same
 * daemon-managed flags as OpenCode's.
 */
const DEVECO_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '--format': 'value',
  '--dir': 'value',
  '--variant': 'value',
  '--dangerously-skip-permissions': 'standalone',
  // 2026-08-16：补齐 daemon 注入的 flag —— 此前调用者的 customArgs 可以
  // 覆盖 daemon 拥有的 --model/--session（与 opencode 适配器对齐）。
  '--model': 'value',
  '--session': 'value',
}

/**
 * Build the deveco CLI argv for a non-interactive `run --format json` run.
 *
 * `deveco run --format json --dangerously-skip-permissions [--dir <cwd>]
 *   [--model <m>] [--variant <v>] [--session <id>] <filtered args> <prompt>`
 *
 * The prompt is a positional argument (DevEco's `run` subcommand has no
 * --prompt flag). `--max-turns` is not supported by DevEco and is ignored.
 * `--system-prompt` is intentionally not forwarded — system context is
 * delivered via the per-task AGENTS.md the daemon writes for deveco.
 */
export function buildDevecoArgs(prompt: string, opts: ExecOptions): string[] {
  const args = ['run', '--format', 'json', '--dangerously-skip-permissions']
  if (opts.cwd) args.push('--dir', opts.cwd)
  if (opts.model) args.push('--model', opts.model)
  if (opts.thinkingLevel) args.push('--variant', opts.thinkingLevel)
  if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId)
  args.push(...filterCustomArgs(opts.extraArgs, DEVECO_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, DEVECO_BLOCKED_ARGS))
  args.push(prompt)
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// NDJSON event types (DevEco / OpenCode engine wire format)
// ────────────────────────────────────────────────────────────────────────────

interface DevecoToolState {
  status?: string
  input?: unknown
  output?: unknown
}

interface DevecoCacheTokens {
  read?: number
  write?: number
}

interface DevecoTokens {
  input?: number
  output?: number
  cache?: DevecoCacheTokens
}

interface DevecoEventPart {
  // text events
  text?: string
  // tool_use events
  tool?: string
  callID?: string
  state?: DevecoToolState
  // step_finish events
  tokens?: DevecoTokens
}

interface DevecoError {
  name?: string
  data?: { message?: string }
}

interface DevecoEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: DevecoEventPart
  error?: DevecoError
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — pure: one JSONL line → AgentEvent[] (+ state mutation)
// ────────────────────────────────────────────────────────────────────────────

/** Extract a human-readable message from a deveco error object. */
function devecoErrorMessage(err: DevecoError | undefined): string {
  if (err?.data?.message) return err.data.message
  if (err?.name) return err.name
  return 'unknown deveco error'
}

/** Convert a tool state output (string | object) to a string. */
function devecoToolOutputToString(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * Parse one DevEco NDJSON line into zero or more unified events, mutating
 * `state` for usage / output / session tracking.
 *
 * Event types handled: text, tool_use (paired call+result), error,
 * step_start (status), step_finish (token usage). DevEco attributes all
 * usage to a single model (it doesn't report model per-step), so usage is
 * keyed under the configured model (or "unknown") at result time by the
 * spawnStreamAgent loop — here we just accumulate into a synthetic
 * `deveco` model key that the caller can remap.
 *
 * Exported as `parseDevecoLine` for direct unit testing.
 */
export function parseDevecoLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  let evt: DevecoEvent
  try {
    evt = JSON.parse(line) as DevecoEvent
  } catch {
    return [{ type: 'log', content: line }]
  }

  const out: AgentEvent[] = []
  if (evt.sessionID) state.sessionId = evt.sessionID
  const part = evt.part ?? {}

  switch (evt.type) {
    case 'text': {
      if (part.text) {
        state.output += part.text
        out.push({ type: 'text', content: part.text })
      }
      break
    }
    case 'tool_use': {
      // A single tool_use event contains both the call and (when
      // state.status == "completed") the result.
      out.push({
        type: 'tool-use',
        tool: part.tool ?? '',
        callId: part.callID ?? '',
        input: part.state?.input,
      })
      if (part.state?.status === 'completed') {
        out.push({
          type: 'tool-result',
          tool: part.tool ?? '',
          callId: part.callID ?? '',
          output: devecoToolOutputToString(part.state.output),
        })
      }
      break
    }
    case 'error': {
      const errMsg = devecoErrorMessage(evt.error)
      state.finalStatus = 'failed'
      state.finalError = errMsg
      out.push({ type: 'error', content: errMsg })
      break
    }
    case 'step_start': {
      if (state.sessionId) {
        out.push({ type: 'status', status: 'running', sessionId: state.sessionId })
      } else {
        out.push({ type: 'status', status: 'running' })
      }
      break
    }
    case 'step_finish': {
      // Accumulate token usage from step_finish events. DevEco doesn't
      // report model per-step, so we attribute to a synthetic key that the
      // caller can remap to the configured model.
      if (part.tokens) {
        const model = 'deveco'
        const u = state.usage[model] ?? { inputTokens: 0, outputTokens: 0 }
        u.inputTokens += part.tokens.input ?? 0
        u.outputTokens += part.tokens.output ?? 0
        u.cacheReadTokens = (u.cacheReadTokens ?? 0) + (part.tokens.cache?.read ?? 0)
        u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + (part.tokens.cache?.write ?? 0)
        state.usage[model] = u
      }
      break
    }
    default:
      out.push({ type: 'log', content: `deveco event: ${evt.type}` })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function devecoBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'deveco'
      const args = buildDevecoArgs(prompt, opts)
      const session = spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'deveco',
        parseLine: parseDevecoLine,
        inputMethod: 'argv', // prompt is already in args (positional)
      })
      // Remap the synthetic 'deveco' usage key to the configured model (or
      // 'unknown') to match multica's attribution behaviour. DevEco doesn't
      // report model per-step, so we key everything under one model.
      const remapped = session.result.then((res) => {
        const synthetic = res.usage['deveco']
        if (!synthetic) return res
        // Drop the synthetic key, then re-attribute under the real model name.
        const rest = { ...res.usage }
        delete rest['deveco']
        const hasUsage =
          synthetic.inputTokens ||
          synthetic.outputTokens ||
          synthetic.cacheReadTokens ||
          synthetic.cacheWriteTokens
        const model = opts.model || 'unknown'
        return hasUsage
          ? { ...res, usage: { ...rest, [model]: synthetic } }
          : { ...res, usage: rest }
      })
      return { events: session.events, result: remapped }
    },
  }
}
