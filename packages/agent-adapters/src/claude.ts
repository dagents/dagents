/**
 * Claude Code adapter — spawn the `claude` CLI with `--output-format stream-json`
 * and parse its newline-delimited JSON into the unified `AgentEvent` stream.
 *
 * Translated from multica `server/pkg/agent/claude.go` (Go `claudeBackend`)
 * to TypeScript, with the bugs in the plan M2.1 template fixed against the
 * real CLI behavior (verified by capturing live stream-json output):
 *
 *   - `--thinking-level` does not exist on the CLI; the flag is `--effort`
 *     (multica uses `--effort`). `ExecOptions.thinkingLevel` maps to `--effort`.
 *   - thinking-block content lives in `block.thinking`, not `block.text`.
 *   - the model is nested (`message.model` for assistant frames,
 *     `modelUsage` keys for the result frame) — there is no top-level
 *     `msg.model` to key usage on.
 *   - authoritative per-model usage comes from the `result.modelUsage` map
 *     (camelCase fields); assistant `message.usage` (snake_case) is only an
 *     incremental hint (its `output_tokens` is usually 0).
 *   - `tool_result` blocks arrive on `user` frames keyed by `tool_use_id`;
 *     the tool name is not present on the result block.
 *   - `--append-system-prompt` (multica) is used instead of `--system-prompt`
 *     so the agent keeps Claude Code's default system prompt and merely adds
 *     to it — replacing it wholesale is rarely what the caller wants.
 *
 * Scope note (M2.1 = Gate-1 头号 spike): this is the minimal correct spawn +
 * parse + usage-aggregation core. The autonomous hardening multica layers on
 * top — `--input-format stream-json` + JSON-framed stdin, `control_request`
 * auto-approve, `--permission-mode bypassPermissions`, root/sudo preflight,
 * and inactivity watchdog — is deferred to the tasks that actually need it
 * (T3 watchdog, M2.4 Gate-1 e2e). MCP temp-file injection + `--mcp-config`
 * pass-through landed in M2.6 (P1.6.T4) via `writeMcpConfigToTemp`; raw text
 * stdin is still sufficient for this spike's e2e until the JSON-framing task.
 */
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import type {
  AgentBackend,
  AgentEvent,
  AgentResult,
  AgentSession,
  BackendConfig,
  ExecOptions,
  Logger,
  TokenUsage,
} from '@dagents/contracts'
import { createLogger } from '@dagents/shared'
import { writeMcpConfigToTemp } from './mcp-config.js'
import type { McpConfigFile } from './mcp-config.js'

// ────────────────────────────────────────────────────────────────────────────
// argv construction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the claude CLI argv for a non-interactive stream-json run.
 *
 * Order mirrors multica `buildClaudeArgs`: the hardcoded protocol base first
 * (so it is readable in `agent command` logs), then model/effort/turns/prompt/
 * resume, then the caller's filtered `extraArgs` and `customArgs`.
 *
 * `log` is optional: when provided, `filterCustomArgs` warns on each blocked
 * protocol-critical flag (mirrors multica `filterCustomArgs`'s `logger.Warn`,
 * claude.go:545) so callers can see why their custom_arg was dropped. Pure
 * unit tests omit it.
 *
 * `mcpConfigPath` is the resolved temp-file path for `--mcp-config` (written
 * by `writeMcpConfigToTemp` from `opts.mcpConfig` before this runs). It is a
 * separate param rather than read off `opts` because temp-file creation is
 * async IO that belongs to `execute`, not this pure argv builder — keeping
 * `buildClaudeArgs` synchronous preserves its direct unit-testability. The
 * flag is blocked in `CLAUDE_BLOCKED_ARGS`, so a caller cannot override the
 * path via `customArgs`; the daemon-owned value always wins.
 */
export function buildClaudeArgs(
  opts: ExecOptions,
  log?: Logger,
  mcpConfigPath?: string,
): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose']
  if (opts.model) args.push('--model', opts.model)
  // `--effort` is the CLI's real reasoning-level flag (the plan's
  // `--thinking-level` does not exist). Slotted right after --model so the
  // per-session effort runs against the same model the args advertise.
  if (opts.thinkingLevel) args.push('--effort', opts.thinkingLevel)
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns))
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  // MCP: inject the daemon-owned --mcp-config path BEFORE filtering customArgs.
  // `--mcp-config` is blocked, so any caller-supplied copy is dropped (with a
  // warn) and this value is authoritative — mirrors how multica owns the flag.
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)
  args.push(...filterCustomArgs(opts.extraArgs, CLAUDE_BLOCKED_ARGS, log))
  args.push(...filterCustomArgs(opts.customArgs, CLAUDE_BLOCKED_ARGS, log))
  return args
}

/**
 * Flags the daemon hardcodes and must not let a caller override via
 * extraArgs/customArgs — overriding any of them breaks the stream-json
 * protocol or the daemon's session/resume ownership. Mirrors multica
 * `claudeBlockedArgs`.
 */
const CLAUDE_BLOCKED_ARGS: Record<string, 'value' | 'standalone'> = {
  '-p': 'standalone',
  '--print': 'standalone',
  '--output-format': 'value',
  '--input-format': 'value',
  '--effort': 'value', // owned by the thinkingLevel picker
  '--resume': 'value', // owned by resumeSessionId
  '--permission-mode': 'value',
  '--mcp-config': 'value',
}

/**
 * Remove protocol-critical flags from caller-configured args. Shell quoting
 * is stripped first (users type custom_args with shell syntax like
 * `--flag='v'`; since we spawn directly without a shell, literal quotes would
 * be passed to the child and rejected). Mirrors multica `filterCustomArgs`.
 *
 * When `log` is provided, emits a `warn` for each blocked flag so a caller
 * can see why their custom_arg was dropped (mirrors multica's `logger.Warn`,
 * claude.go:545). Pure unit tests pass `undefined` for `log`.
 */
function filterCustomArgs(
  args: string[] | undefined,
  blocked: Record<string, 'value' | 'standalone'>,
  log?: Logger,
): string[] {
  if (!args || args.length === 0) return []
  const out: string[] = []
  let skip = false
  for (const raw of args) {
    if (skip) {
      skip = false
      continue
    }
    const arg = unshellQuote(raw)
    let flag = arg
    let inlineValue = false
    const eq = arg.indexOf('=')
    if (eq > 0) {
      flag = arg.slice(0, eq)
      inlineValue = true
    }
    const mode = blocked[flag]
    if (mode) {
      // blocked: drop the flag; if it takes a separate value arg, drop that too.
      log?.warn('custom_args: blocked protocol-critical flag, skipping', { flag })
      if (mode === 'value' && !inlineValue) skip = true
      continue
    }
    out.push(arg)
  }
  return out
}

/** Strip one layer of surrounding shell quotes from a value or whole arg. */
function unshellQuote(arg: string): string {
  if (arg.startsWith('-')) {
    const eq = arg.indexOf('=')
    if (eq > 0) {
      const value = arg.slice(eq + 1)
      const stripped = stripSurroundingQuotes(value)
      if (stripped !== null) return arg.slice(0, eq + 1) + stripped
      return arg
    }
  }
  const stripped = stripSurroundingQuotes(arg)
  return stripped !== null ? stripped : arg
}

function stripSurroundingQuotes(s: string): string | null {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return s.slice(1, -1)
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// stream-json message types (subset of the Claude Code SDK wire format)
// ────────────────────────────────────────────────────────────────────────────

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface ClaudeMessage {
  model?: string
  usage?: ClaudeUsage
  content?: ClaudeContentBlock[]
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** camelCase — result.modelUsage values use this shape. */
interface ClaudeModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

interface ClaudeStreamMessage {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  message?: ClaudeMessage
  /** result frame */
  result?: string
  is_error?: boolean
  usage?: ClaudeUsage
  modelUsage?: Record<string, ClaudeModelUsage>
  log?: { level?: string; message?: string }
}

// ────────────────────────────────────────────────────────────────────────────
// parseEvent — pure: ClaudeStreamMessage → AgentEvent[]
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert one stream-json message into zero or more unified events.
 *
 * Pure and side-effect-free so it is trivially unit-testable; usage
 * aggregation (which needs the whole result frame) lives in the execute loop.
 */
export function parseEvent(msg: ClaudeStreamMessage): AgentEvent[] {
  const out: AgentEvent[] = []

  if (msg.type === 'system') {
    // `init` is the real session-start marker; the other system subtypes
    // (hook_started/hook_response/thinking_tokens) are protocol noise we do
    // not surface. multica emits a status on every system frame; we emit one
    // on init only, which is the semantic "started".
    if (msg.subtype === 'init' && msg.session_id) {
      out.push({ type: 'status', status: 'started', sessionId: msg.session_id })
    }
    return out
  }

  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        out.push({ type: 'text', content: block.text })
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

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_result') {
        out.push({
          type: 'tool-result',
          tool: '',
          callId: block.tool_use_id ?? '',
          output: toolResultContentToString(block.content),
        })
      }
    }
    return out
  }

  if (msg.type === 'result') {
    // Terminal frame. multica resets the accumulated output to the result
    // text (authoritative final answer) and does NOT re-emit it as a text
    // event — the assistant already streamed it. We surface a `completed`
    // status; the loop handles the output reset + usage aggregation.
    if (msg.session_id) {
      out.push({ type: 'status', status: 'completed', sessionId: msg.session_id })
    }
    return out
  }

  if (msg.type === 'log' && msg.log?.message) {
    out.push({ type: 'log', content: msg.log.message })
  }

  return out
}

/** tool_result.content may be a plain string or an array of content blocks. */
function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
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
// usage aggregation
// ────────────────────────────────────────────────────────────────────────────

/** Accumulate per-model usage from an assistant frame's `message.usage`.
 *
 * Exported so the per-model aggregation can be unit-tested directly without
 * driving a full subprocess (the multi-model "不串不丢" invariant — each
 * model's counters accumulate independently, never merged across models). */
export function accumulateAssistantUsage(
  usage: Record<string, TokenUsage>,
  message: ClaudeMessage,
): void {
  const u = message.usage
  if (!u || !message.model) return
  const existing = usage[message.model] ?? { inputTokens: 0, outputTokens: 0 }
  existing.inputTokens += u.input_tokens ?? 0
  existing.outputTokens += u.output_tokens ?? 0
  existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  existing.cacheWriteTokens =
    (existing.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  usage[message.model] = existing
}

/**
 * Compute authoritative per-model usage from a `result` frame. Prefers
 * `modelUsage` (camelCase, per-model breakdown); falls back to the top-level
 * `usage` (snake_case) attributed to `msg.model` or the requested model.
 * Returns null if no tokens are present. Mirrors multica `claudeResultUsage`.
 *
 * `hasTokens` includes `cacheCreationInputTokens` to match multica
 * `claudeUsageHasTokens` (claude.go): a frame that only created cache (no
 * input/output yet) is still a real usage record, not an empty one.
 *
 * Exported for direct unit testing of the multi-model aggregation invariants
 * (per-model independence, zero-token filtering, modelUsage→usage fallback).
 */
export function resultUsage(
  msg: ClaudeStreamMessage,
  fallbackModel: string | undefined,
): Record<string, TokenUsage> | null {
  if (msg.modelUsage) {
    const out: Record<string, TokenUsage> = {}
    for (const [model, u] of Object.entries(msg.modelUsage)) {
      if (!model) continue
      if (!modelUsageHasTokens(u)) continue
      out[model] = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        // Normalize with `?? 0` so a modelUsage entry that only reports some
        // fields (e.g. cache-only) still yields a fully-shaped TokenUsage with
        // numeric zeros — never `undefined` — matching multica's Go int64
        // zero-default and keeping downstream usage persistence type-stable.
        cacheReadTokens: u.cacheReadInputTokens ?? 0,
        cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
      }
    }
    if (Object.keys(out).length > 0) return out
  }
  const model = msg.model || fallbackModel
  const u = msg.usage
  if (!model || !u) return null
  if (!usageHasTokens(u)) return null
  return {
    [model]: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  }
}

/** True if a result-frame per-model entry carries any token activity at all. */
function modelUsageHasTokens(u: ClaudeModelUsage): boolean {
  return (
    (u.inputTokens ?? 0) !== 0 ||
    (u.outputTokens ?? 0) !== 0 ||
    (u.cacheReadInputTokens ?? 0) !== 0 ||
    (u.cacheCreationInputTokens ?? 0) !== 0
  )
}

/** True if a snake_case `usage` block carries any token activity at all. */
function usageHasTokens(u: ClaudeUsage): boolean {
  return (
    (u.input_tokens ?? 0) !== 0 ||
    (u.output_tokens ?? 0) !== 0 ||
    (u.cache_read_input_tokens ?? 0) !== 0 ||
    (u.cache_creation_input_tokens ?? 0) !== 0
  )
}

// ────────────────────────────────────────────────────────────────────────────
// env filtering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Inherited env vars that are internal Claude Code runtime/session markers.
 * They MUST NOT leak into the spawned child, or the child mistakes itself for
 * a nested or resumed session / inherits the parent's exec path. User-facing
 * `CLAUDE_CODE_*` config (GIT_BASH_PATH, USE_BEDROCK, MAX_OUTPUT_TOKENS, …)
 * is intentionally NOT stripped — callers set those deliberately. Mirrors
 * multica `isFilteredChildEnvKey`.
 */
function isFilteredChildEnvKey(key: string): boolean {
  switch (key) {
    case 'CLAUDECODE':
    case 'CLAUDE_CODE_ENTRYPOINT':
    case 'CLAUDE_CODE_EXECPATH':
    case 'CLAUDE_CODE_SESSION_ID':
    case 'CLAUDE_CODE_SSE_PORT':
      return true
    default:
      return key.startsWith('CLAUDECODE_')
  }
}

function buildChildEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of Object.entries(process.env)) {
    const [key, value] = entry
    if (key === undefined || value === undefined) continue
    if (isFilteredChildEnvKey(key)) continue
    env[key] = value
  }
  return { ...env, ...(extra ?? {}) }
}

// ────────────────────────────────────────────────────────────────────────────
// backend
// ────────────────────────────────────────────────────────────────────────────

const STDERR_TAIL_BYTES = 4 * 1024
/** Grace period after SIGTERM before escalating to SIGKILL (mirrors multica `cmd.WaitDelay`). */
const SIGKILL_GRACE_MS = 5_000

/**
 * Single-consumer async queue backing `AgentSession.events`.
 *
 * The run pushes events as they arrive (eagerly, at the agent's own pace); the
 * consumer pulls them via the async iterator. When the run finishes it calls
 * `close()` and the consumer drains the remaining buffer then sees EOF.
 *
 * This decouples `events` from `result`: `result` awaits the run's completion
 * WITHOUT pulling from the queue, so a concurrent `events` consumer never has
 * its items stolen (the bug fixed in review #2 — the prior single-generator
 * design let `result`'s drain and the caller's iteration race on `.next()`).
 * Mirrors multica's separate buffered `msgCh` (events) + `resCh` (result).
 *
 * Single-consumer (like multica's channel): a second iterator over the same
 * queue would interleave with the first. `AgentSession.events` is documented
 * as single-consumer.
 *
 * Unbounded by design: the run must always progress at the agent's pace so the
 * wall-clock timeout is the only thing that can stall it. multica's msgCh is
 * bounded(256) and DROPS under backpressure (final output is accumulated
 * separately in `Result.output`, so only streaming consumers lose data); we
 * keep every event instead, trading memory for no loss — acceptable for the
 * bounded agent runs of this spike.
 */
class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private buf: AgentEvent[] = []
  private waiters: Array<(done: boolean) => void> = []
  private closed = false

  push(value: AgentEvent): void {
    if (this.closed) return
    // Always buffer first, then wake a waiter — the waiter pulls from the
    // buffer on resume. (Resolving the waiter without buffering loses the
    // value: the consumer's `next()` would `shift()` an empty buffer.)
    this.buf.push(value)
    this.waiters.shift()?.(false)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()!(true)
    }
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    if (this.buf.length > 0) {
      return { value: this.buf.shift()!, done: false }
    }
    if (this.closed) {
      return { value: undefined, done: true }
    }
    const done = await new Promise<boolean>((resolve) => this.waiters.push(resolve))
    if (done) return { value: undefined, done: true }
    return { value: this.buf.shift()!, done: false }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return { next: () => this.next() }
  }
}

export function claudeBackend(cfg: BackendConfig): AgentBackend {
  const log: Logger = cfg.logger ?? createLogger({ svc: 'claude-adapter' })
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'claude'
      const startedAt = Date.now()

      // Shared mutable state updated by the run, read by `result`. These are
      // assigned-before-read in practice: the run updates them as it parses,
      // and `result` only reads them after the run resolves.
      let usage: Record<string, TokenUsage> = {}
      let sessionId: string | undefined
      let output = ''
      let finalStatus: AgentResult['status'] = 'completed'
      let finalError: string | undefined

      const queue = new AsyncEventQueue()

      // Eagerly start the subprocess so the run always happens even when the
      // caller awaits only `result` (mirrors multica's unconditional goroutine;
      // the prior lazy-generator design skipped spawning if nobody iterated).
      // MCP config materialization is awaited inside the run so the temp file
      // exists before spawn AND a serialization failure rejects `result`
      // (rather than throwing synchronously out of `execute`, which the
      // caller's `AgentSession` contract does not expect).
      let mcpFile: McpConfigFile | null = null
      const done = (async (): Promise<AgentResult> => {
        // MCP: write opts.mcpConfig to a private temp file for the run's
        // lifetime. Returns null when there is nothing to inject (absent or
        // empty), in which case --mcp-config is omitted entirely. Cleanup is
        // deferred to the `finally` below so a spawn/parse/timeout failure
        // still removes the temp file.
        try {
          mcpFile = await writeMcpConfigToTemp(opts.mcpConfig)
        } catch (err) {
          // Non-serializable / wrong-typed mcpConfig: fail the run with a
          // clear cause rather than spawning without MCP silently.
          finalStatus = 'failed'
          finalError = `claude mcp-config write failed: ${(err as Error).message}`
          queue.close()
          return {
            status: finalStatus,
            output,
            error: finalError,
            durationMs: Date.now() - startedAt,
            sessionId,
            usage,
          }
        }
        const args = buildClaudeArgs(opts, log, mcpFile?.path)

        const proc = spawn(execPath, args, {
          cwd: opts.cwd,
          env: buildChildEnv(cfg.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        log.info('claude spawn', { exec: execPath, args, cwd: opts.cwd })

        let stderrTail = ''

        // Spawn failure (ENOENT: binary missing, EACCES, …). Without this
        // handler Node raises it as an uncaughtException and kills the daemon
        // (review #1). Record a failed result; the 'error' event also drives
        // stdout to EOF, so the readline loop ends on its own. Do NOT destroy
        // stdout here — destroying it rejects the readline async iterator,
        // which throws out of the `for await` and hangs `done` (verified).
        // multica prechecks this with exec.LookPath (claude.go:28-30); we
        // handle it at the spawn-error event instead, covering start failures.
        proc.on('error', (err) => {
          log.error('claude spawn error', { error: err.message })
          finalStatus = 'failed'
          finalError = `claude spawn failed: ${err.message}`
        })
        // EPIPE on stdin/stdout happens when the child exits before we finish
        // writing (e.g. it crashed on startup). Swallow — the exit code / close
        // path is the authoritative failure signal, surfacing it here would
        // crash the daemon. Mirrors multica's writeClaudeInput error recovery.
        proc.stdin?.on('error', () => {})
        proc.stdout?.on('error', () => {})

        // Hoisted BEFORE the readline loop: on ENOENT the 'error' event fires
        // on the next tick, while the readline for-await is still running — a
        // `once('error')` registered only after the loop would miss it and the
        // race would hang (close never fires for a process that never started).
        // Registering both listeners here guarantees the race resolves no
        // matter which fires. Whichever fires first wins; the second is a
        // no-op (resolve is idempotent for a Promise).
        const exitCode = new Promise<number | null>((resolve) => {
          proc.once('close', resolve)
          proc.once('error', () => resolve(null))
        })

        proc.stderr!.on('data', (d: Buffer) => {
          const s = d.toString()
          log.warn('claude stderr', { chunk: s.slice(-512) })
          stderrTail = (stderrTail + s).slice(-STDERR_TAIL_BYTES)
        })

        // Wall-clock timeout (multica `Timeout`). SIGTERM lets the CLI flush;
        // if it ignores SIGTERM, escalate to SIGKILL after a grace period and
        // destroy stdout to force the readline loop to EOF (review #3 — the
        // prior SIGTERM-only design hung forever if the child trapped it).
        // Mirrors multica `cmd.WaitDelay = 10s` (forced pipe close + reap).
        //
        // Inactivity watchdog (multica `SemanticInactivityTimeout` / daemon
        // idle watchdog): a separate timer that resets on every line the child
        // emits and, when it fires, kills the same way. A child that stays
        // alive but goes silent (stuck tool, wedged MCP) is force-stopped and
        // resolved `aborted`, distinct from the total-budget `timeout`. The
        // plan §M2.5 maps inactivity → `aborted`; multica itself routes
        // cancellation → `aborted` (claude.go:220-221) and delegates true
        // silence-detection to the daemon's idle watchdog — we fold a
        // best-effort silence layer into the adapter so a wedged CLI never
        // hangs a task even without the daemon watchdog wired yet.
        //
        // TODO(#7, review): no AbortSignal / `aborted`|`cancelled` path yet —
        // `ExecOptions` carries no signal and multica's `context.Canceled` →
        // `aborted` mapping (claude.go:196-198) is unimplemented. Add when the
        // dispatch layer threads a cancellation signal through `execute`.
        let timer: NodeJS.Timeout | undefined
        let killTimer: NodeJS.Timeout | undefined
        let inactivityTimer: NodeJS.Timeout | undefined
        let timedOut = false
        let stalled = false

        // SIGTERM (let the CLI flush) → SIGKILL after the grace period. Shared
        // by both watchdogs so the escalation rules stay identical (a child
        // that traps SIGTERM is force-killed either way). Idempotent: a second
        // call when the proc is already dead is a no-op, so overlapping
        // wall-clock + inactivity fires are safe.
        const killWithEscalation = (): void => {
          proc.kill('SIGTERM')
          if (killTimer) clearTimeout(killTimer)
          // Freeze the inactivity watchdog once we've begun escalating: a late
          // line flushed during the SIGTERM grace must not re-arm it (the run is
          // already being torn down — `timedOut`/`stalled` decide the status).
          // Nilling the handle makes `resetInactivity`'s `if (!inactivityTimer)
          // return` guard a hard stop, so no new timer is scheduled post-kill.
          if (inactivityTimer) {
            clearTimeout(inactivityTimer)
            inactivityTimer = undefined
          }
          killTimer = setTimeout(() => {
            // `proc.killed` only means "we already called kill()", NOT
            // "the process is dead" — a child that traps SIGTERM stays
            // alive with `killed === true`. Always escalate: a SIGKILL on an
            // already-exited process is a harmless no-op, and skipping here
            // is exactly the review #3 hang. (We do NOT destroy stdout —
            // destroying it rejects the readline iterator and hangs `done`;
            // SIGKILL closes the child's stdout end, which drives ours to
            // EOF and ends the loop cleanly.)
            proc.kill('SIGKILL')
          }, SIGKILL_GRACE_MS)
        }

        if (opts.timeoutMs && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true
            killWithEscalation()
          }, opts.timeoutMs)
        }

        // Arm (first call) or reset (subsequent calls) the inactivity timer.
        // Reset on every emitted line so a chatty-but-slow run is never killed
        // merely for running long — only a truly silent one trips it. Cleared
        // alongside the wall-clock timers once the run resolves.
        const resetInactivity = (): void => {
          if (!inactivityTimer) return
          clearTimeout(inactivityTimer)
          inactivityTimer = setTimeout(() => {
            stalled = true
            killWithEscalation()
          }, opts.inactivityTimeoutMs as number)
        }
        if (opts.inactivityTimeoutMs && opts.inactivityTimeoutMs > 0) {
          inactivityTimer = setTimeout(() => {
            stalled = true
            killWithEscalation()
          }, opts.inactivityTimeoutMs)
        }

        // Write the prompt and signal EOF. `end(chunk)` handles backpressure
        // internally; write errors are swallowed by the stdin 'error' handler
        // above. Raw text input is fine for M2.1 (no --input-format
        // stream-json); the hardening tasks add JSON framing.
        proc.stdin!.end(prompt)

        const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity })
        try {
          // No `spawnFailed` short-circuit: on ENOENT the 'error' event
          // fires AND Node still drives stdout to EOF (verified: readline's
          // for-await ends cleanly), so the loop naturally receives no lines
          // and falls through to the close-await. Skipping here would race
          // against the early 'error' event.
          for await (const line of rl) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let msg: ClaudeStreamMessage
            try {
              msg = JSON.parse(trimmed) as ClaudeStreamMessage
            } catch {
              // Non-JSON line (banner, debug) — surface as a log event.
              queue.push({ type: 'log', content: trimmed })
              // Still counts as activity: a line on stdout proves the child
              // is alive even if it isn't valid stream-json.
              resetInactivity()
              continue
            }

            if (msg.session_id) sessionId = msg.session_id

            // Per-model usage from assistant frames (incremental; output
            // tokens are usually 0 here — the authoritative count comes from
            // the result frame below).
            if (msg.type === 'assistant' && msg.message) {
              accumulateAssistantUsage(usage, msg.message)
            }

            // Authoritative usage from the result frame replaces the
            // incremental accumulation (multica `claudeResultUsage`).
            if (msg.type === 'result') {
              if (msg.result) {
                output = msg.result
              }
              if (msg.is_error) {
                finalStatus = 'failed'
                finalError = msg.result || undefined
              }
              const ru = resultUsage(msg, opts.model)
              if (ru) usage = ru
            }

            for (const ev of parseEvent(msg)) {
              // Accumulate streamed assistant text so Result.output is
              // non-empty even if the result frame carries no `result` text.
              // The result frame (when present) overrides this above; it is
              // the terminal frame, so nothing appends after the reset.
              if (ev.type === 'text') output += ev.content
              queue.push(ev)
            }

            // Every parsed stream-json line resets the inactivity watchdog:
            // a run that keeps emitting (even slowly) is alive; only a truly
            // silent one trips it.
            resetInactivity()
          }
        } finally {
          rl.close()
        }

        // Resolve on close (normal exit) OR a spawn error (ENOENT — the
        // 'error' event fires and stdout hits EOF, but `close` may not). The
        // Promise was created (and both listeners attached) BEFORE the
        // readline loop, so the early 'error' event can't slip past it.
        const code = await exitCode
        if (timer) clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (inactivityTimer) clearTimeout(inactivityTimer)

        // Precedence: total-budget timeout beats silence; both beat a non-zero
        // exit. A run that hit the inactivity watchdog resolves `aborted`
        // (distinct from `timeout`) so callers can tell "ran past budget" from
        // "went silent mid-run" — the plan §M2.5 mapping.
        if (timedOut) {
          finalStatus = 'timeout'
          finalError = `claude timed out after ${opts.timeoutMs}ms`
        } else if (stalled) {
          finalStatus = 'aborted'
          finalError = `claude stalled: no output for ${opts.inactivityTimeoutMs}ms`
        } else if (code !== 0 && code !== null && finalStatus === 'completed') {
          finalStatus = 'failed'
          finalError = `claude exited with code ${code}`
        }
        if (finalError && stderrTail) {
          finalError = `${finalError}\n--- claude stderr (tail) ---\n${stderrTail}`
        }

        return {
          status: finalStatus,
          output,
          error: finalError,
          durationMs: Date.now() - startedAt,
          sessionId,
          usage,
        }
      })().finally(() => {
        // Remove the MCP temp file after the run settles (success OR failure).
        // `cleanup()` is total (never rejects), so this can't turn a success
        // into a rejection. Skipping it would leak a per-run temp file — for
        // a long-lived daemon that is an unbounded file leak.
        if (mcpFile) void mcpFile.cleanup()
      })

      // `result` resolves when the run completes. It does NOT drain `events`,
      // so a concurrent events consumer never has its items stolen — the
      // dual-channel fix for review #2.
      const result: Promise<AgentResult> = done

      // Close the events queue once the run is over (resolve OR reject) so the
      // consumer drains the buffer then sees EOF instead of hanging.
      void done.then(
        () => queue.close(),
        () => queue.close(),
      )

      const events: AsyncIterable<AgentEvent> = queue

      return { events, result }
    },
  }
}
