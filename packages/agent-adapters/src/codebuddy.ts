/**
 * CodeBuddy adapter — spawn `codebuddy -p --output-format stream-json
 * --input-format stream-json` and parse its NDJSON event stream.
 *
 * CodeBuddy is a Claude Code fork and speaks the SAME stream-json protocol as
 * `claude.ts` (system/assistant/user/result frames with content blocks).
 * The per-line parser is therefore a thin wrapper over `parseEvent` from
 * `claude.ts` — we only add per-model usage aggregation from assistant
 * frames (mirroring multica's `codebuddy.go` `handleAssistant`).
 *
 * Translated from multica `codebuddy.go`.
 *
 * Two protocol differences from the claude adapter:
 *   - `--input-format stream-json` is set so control_request auto-approval
 *     can flow back over stdin (we don't implement the auto-approver in this
 *     MVP — stdout parsing is enough; the stdin channel stays open via the
 *     argv prompt path, so a control_request is simply not answered and the
 *     CLI times out the call itself).
 *   - `--permission-mode bypassPermissions`, `--strict-mcp-config`, and
 *     `--disallowedTools AskUserQuestion` are hardcoded for autonomous
 *     daemon operation.
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
import { parseEvent } from './claude.js'
import type { ClaudeStreamMessage } from './claude.js'

// ────────────────────────────────────────────────────────────────────────────
// argv construction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Flags the daemon hardcodes and must not let a caller override via
 * extraArgs/customArgs. Overriding these would break the stream-json
 * protocol or the daemon's session/resume ownership. Mirrors multica
 * `codebuddyBlockedArgs`.
 */
const CODEBUDDY_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'standalone',
  '--output-format': 'value',
  '--input-format': 'value',
  '--permission-mode': 'value',
  '--mcp-config': 'value',
  '--effort': 'value',
}

/**
 * Build the codebuddy CLI argv for a non-interactive stream-json run.
 *
 * Order mirrors multica `buildCodebuddyArgs`: the hardcoded protocol base
 * first (so it is readable in `agent command` logs), then model/effort/turns/
 * system-prompt/resume, then the caller's filtered args.
 *
 * Like the claude adapter, the prompt is written to stdin via the stream-json
 * input-format framing — but for this MVP we use the simpler `--input-format
 * stream-json` + raw-text stdin path (the CLI accepts a raw text prompt on
 * stdin even with input-format set, treating it as a single user turn).
 * `inputMethod: 'stdin'` is used so `spawnStreamAgent` writes the prompt.
 */
export function buildCodebuddyArgs(opts: ExecOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'AskUserQuestion',
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.thinkingLevel) args.push('--effort', opts.thinkingLevel)
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns))
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  args.push(...filterCustomArgs(opts.extraArgs, CODEBUDDY_BLOCKED_ARGS))
  args.push(...filterCustomArgs(opts.customArgs, CODEBUDDY_BLOCKED_ARGS))
  return args
}

// ────────────────────────────────────────────────────────────────────────────
// parseLine — delegate to claude's parseEvent + add usage aggregation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse one CodeBuddy stream-json line. CodeBuddy shares Claude Code's
 * stream-json schema, so we delegate the event extraction to
 * `parseEvent` (exported from `claude.ts`). We additionally aggregate
 * per-model token usage from assistant frames (mirrors multica
 * `codebuddy.go`'s `handleAssistant` usage block) and set the session id
 * on the run state.
 *
 * Exported as `parseCodebuddyLine` for direct unit testing.
 */
export function parseCodebuddyLine(line: string, state: StreamAgentRunState): AgentEvent[] {
  let msg: ClaudeStreamMessage
  try {
    msg = JSON.parse(line) as ClaudeStreamMessage
  } catch {
    return [{ type: 'log', content: line }]
  }

  // Track session id from any frame that carries it (system/result).
  if (msg.session_id) state.sessionId = msg.session_id

  // Aggregate per-model usage from assistant frames (incremental). The
  // authoritative final usage comes from the `result` frame's `modelUsage`,
  // handled below.
  if (msg.type === 'assistant' && msg.message?.usage && msg.message.model) {
    const u = msg.message.usage
    const existing = state.usage[msg.message.model] ?? { inputTokens: 0, outputTokens: 0 }
    existing.inputTokens += u.input_tokens ?? 0
    existing.outputTokens += u.output_tokens ?? 0
    existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    existing.cacheWriteTokens =
      (existing.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    state.usage[msg.message.model] = existing
  }

  // Authoritative per-model usage from the result frame's modelUsage map
  // (camelCase). Replaces the incremental assistant-frame accumulation.
  if (msg.type === 'result' && msg.modelUsage) {
    const merged: Record<string, typeof state.usage[string]> = {}
    let any = false
    for (const [model, u] of Object.entries(msg.modelUsage)) {
      if (!model) continue
      const has =
        (u.inputTokens ?? 0) !== 0 ||
        (u.outputTokens ?? 0) !== 0 ||
        (u.cacheReadInputTokens ?? 0) !== 0 ||
        (u.cacheCreationInputTokens ?? 0) !== 0
      if (!has) continue
      any = true
      merged[model] = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadInputTokens ?? 0,
        cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
      }
    }
    if (any) state.usage = merged
  }

  return parseEvent(msg)
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

export function codebuddyBackend(cfg: BackendConfig): AgentBackend {
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'codebuddy'
      const args = buildCodebuddyArgs(opts)
      return spawnStreamAgent({
        execPath,
        args,
        opts,
        cfg,
        agentName: 'codebuddy',
        parseLine: parseCodebuddyLine,
        inputMethod: 'stdin',
        stdinPayload: prompt,
      })
    },
  }
}
