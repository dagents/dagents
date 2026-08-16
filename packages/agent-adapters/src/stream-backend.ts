/**
 * Shared stream-backend infrastructure — the spawn + readline + timeout +
 * kill-escalation lifecycle extracted from `claude.ts` so every stream-JSON /
 * NDJSON agent adapter (codex, qwen, copilot, opencode, …) reuses one
 * battle-tested implementation.
 *
 * What lives here (agent-agnostic):
 *   - `AsyncEventQueue`         single-consumer queue backing `AgentSession.events`
 *   - `filterCustomArgs` + helpers  CLI arg safety (strip shell quotes, drop
 *                                  protocol-critical flags from caller args)
 *   - `buildChildEnv`            env var inheritance with optional filtering
 *   - `spawnStreamAgent`         the full spawn→readline→timeout→kill lifecycle
 *   - `STDERR_TAIL_BYTES`, `SIGKILL_GRACE_MS`  tuning constants
 *
 * What stays in each adapter (agent-specific):
 *   - argv construction (`buildCodexArgs`, `buildQwenArgs`, …)
 *   - per-line parsing (`parseLine`) — the ONLY adapter-specific logic
 *
 * The lifecycle in `spawnStreamAgent` is a faithful extraction of
 * `claude.ts`'s `claudeBackend()` run loop (spawn error handling, exitCode
 * close+error race, stderr tail, killWithEscalation SIGTERM→SIGKILL,
 * wall-clock timeout, inactivity watchdog, readline loop, status precedence).
 * `claude.ts` keeps its own copy (it is working and tested); new adapters
 * build on this shared module instead.
 */
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import type {
  AgentEvent,
  AgentResult,
  BackendConfig,
  ExecOptions,
  Logger,
  TokenUsage,
} from '@dagents/contracts'
import { createLogger } from '@dagents/shared'

// ────────────────────────────────────────────────────────────────────────────
// tuning constants
// ────────────────────────────────────────────────────────────────────────────

/** Max bytes of stderr captured for inclusion in error messages. */
export const STDERR_TAIL_BYTES = 4 * 1024

/** Grace period after SIGTERM before escalating to SIGKILL (mirrors multica `cmd.WaitDelay`). */
export const SIGKILL_GRACE_MS = 5_000

// ────────────────────────────────────────────────────────────────────────────
// AsyncEventQueue — single-consumer queue backing AgentSession.events
// ────────────────────────────────────────────────────────────────────────────

/**
 * Single-consumer async queue backing `AgentSession.events`.
 *
 * The run pushes events as they arrive (eagerly, at the agent's own pace); the
 * consumer pulls them via the async iterator. When the run finishes it calls
 * `close()` and the consumer drains the remaining buffer then sees EOF.
 *
 * This decouples `events` from `result`: `result` awaits the run's completion
 * WITHOUT pulling from the queue, so a concurrent `events` consumer never has
 * its items stolen. Mirrors multica's separate buffered `msgCh` (events) +
 * `resCh` (result).
 *
 * Single-consumer: a second iterator over the same queue would interleave with
 * the first. Unbounded by design: the run must always progress at the agent's
 * pace so the wall-clock timeout is the only thing that can stall it.
 */
export class AsyncEventQueue implements AsyncIterable<AgentEvent> {
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

// ────────────────────────────────────────────────────────────────────────────
// CLI arg safety — filterCustomArgs + helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Remove protocol-critical flags from caller-configured args. Shell quoting
 * is stripped first (users type custom_args with shell syntax like
 * `--flag='v'`; since we spawn directly without a shell, literal quotes would
 * be passed to the child and rejected). Mirrors multica `filterCustomArgs`.
 *
 * When `log` is provided, emits a `warn` for each blocked flag so a caller
 * can see why their custom_arg was dropped. Pure unit tests pass `undefined`.
 */
export function filterCustomArgs(
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
export function unshellQuote(arg: string): string {
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

export function stripSurroundingQuotes(s: string): string | null {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return s.slice(1, -1)
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// env filtering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Inherited env vars that are internal runtime/session markers for known
 * stream-JSON agents. They MUST NOT leak into the spawned child, or the child
 * mistakes itself for a nested or resumed session / inherits the parent's exec
 * path. Currently covers Claude Code internal markers (the primary source of
 * such leakage). User-facing config vars (e.g. `CLAUDE_CODE_*` config like
 * GIT_BASH_PATH, USE_BEDROCK, …) are intentionally NOT stripped — callers set
 * those deliberately. Mirrors multica `isFilteredChildEnvKey`.
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

/**
 * Build the child process environment: inherit `process.env` minus internal
 * runtime markers, then overlay the backend's extra env. Mirrors multica
 * `buildEnv`.
 *
 * `shouldFilter` lets an adapter add agent-specific env filtering on top of
 * the default; it is OR-ed with the built-in filter (a key is stripped if
 * either returns true). Defaults to stripping nothing extra.
 */
export function buildChildEnv(
  extra: Record<string, string> | undefined,
  shouldFilter?: (key: string) => boolean,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of Object.entries(process.env)) {
    const [key, value] = entry
    if (key === undefined || value === undefined) continue
    if (isFilteredChildEnvKey(key)) continue
    if (shouldFilter?.(key)) continue
    env[key] = value
  }
  return { ...env, ...(extra ?? {}) }
}

// ────────────────────────────────────────────────────────────────────────────
// spawnStreamAgent — the shared lifecycle
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mutable run state shared between `spawnStreamAgent` and the adapter's
 * `parseLine`. The adapter mutates these fields as it parses each line;
 * `spawnStreamAgent` reads them when building the final `AgentResult`.
 */
export interface StreamAgentRunState {
  /** Per-model token usage, keyed by model name. */
  usage: Record<string, TokenUsage>
  /** Agent session id (for resume). Set by parseLine when the CLI emits it. */
  sessionId: string | undefined
  /** Accumulated final output text. Set by parseLine (result text + streamed text). */
  output: string
  /** Final status; parseLine may set this to 'failed' on an error/result frame. */
  finalStatus: AgentResult['status']
  /** Final error message; parseLine may set this on an error/result frame. */
  finalError: string | undefined
}

/** Parse one stdout line into zero or more events, mutating `state` for tracking. */
export type LineHandler = (line: string, state: StreamAgentRunState) => AgentEvent[]

/**
 * Configuration for `spawnStreamAgent`.
 */
export interface StreamAgentConfig {
  /** Path to the CLI binary (e.g. `codex`, `qwen`). */
  execPath: string
  /** Pre-built argv (from the adapter's `buildXxxArgs`). */
  args: string[]
  /** Per-execution options (cwd, timeoutMs, inactivityTimeoutMs, …). */
  opts: ExecOptions
  /** Backend config (env, logger). */
  cfg: BackendConfig
  /** Agent name for log messages, e.g. `'codex'`, `'qwen'`. */
  agentName: string
  /** Parse one stdout line into events; mutate state for usage/output tracking. */
  parseLine: LineHandler
  /** Optional: cleanup callback (e.g. MCP temp file) after run settles. */
  cleanup?: () => Promise<void> | void
  /**
   * Prompt input method: `'stdin'` (default) writes `stdinPayload` to stdin;
   * `'argv'` means prompt is already in args and stdin is not written.
   */
  inputMethod?: 'stdin' | 'argv'
  /**
   * The bytes to write to the child's stdin (stdin mode only). For claude/codex
   * this is the prompt; `end()` is called immediately after, signalling EOF.
   * Ignored when `inputMethod === 'argv'`.
   */
  stdinPayload?: string
}

/**
 * Spawn a stream-JSON / NDJSON agent CLI and drive the full run lifecycle:
 * spawn → readline loop (calling `parseLine` per line) → timeout/watchdog →
 * kill escalation → result resolution.
 *
 * Returns immediately with `{ events, result }`:
 *   - `events` is an `AsyncEventQueue` (pushed to as lines arrive)
 *   - `result` resolves when the run finishes (exit, timeout, or error)
 *
 * The run starts eagerly (even if nobody iterates `events`), mirroring
 * multica's unconditional goroutine and claude.ts's design.
 *
 * Lifecycle details faithfully replicated from `claude.ts`:
 *   - `proc.on('error')` for spawn failures (ENOENT, EACCES)
 *   - stdin/stdout `on('error')` to swallow EPIPE
 *   - `exitCode` Promise racing `close` + `error` (registered BEFORE the
 *     readline loop so an early spawn-error can't slip past)
 *   - stderr tail capture for error messages
 *   - `killWithEscalation`: SIGTERM → SIGKILL after `SIGKILL_GRACE_MS`
 *   - wall-clock timeout timer (`opts.timeoutMs`)
 *   - inactivity watchdog (`opts.inactivityTimeoutMs`) reset on every line
 *   - `stdin.end(prompt)` for stdin mode
 *   - status precedence: timeout > stalled(aborted) > non-zero-exit > completed
 *   - `cleanup()` in a `finally` (never rejects)
 */
export function spawnStreamAgent(config: StreamAgentConfig): {
  events: AsyncEventQueue
  result: Promise<AgentResult>
} {
  const { execPath, args, opts, cfg, agentName, parseLine, cleanup, inputMethod = 'stdin', stdinPayload = '' } = config
  const log: Logger = cfg.logger ?? createLogger({ svc: `${agentName}-adapter` })

  const startedAt = Date.now()
  const queue = new AsyncEventQueue()

  // Shared mutable state updated by parseLine (via the run loop), read by `result`.
  const state: StreamAgentRunState = {
    usage: {},
    sessionId: undefined,
    output: '',
    finalStatus: 'completed',
    finalError: undefined,
  }

  // Eagerly start the subprocess so the run always happens even when the
  // caller awaits only `result` (mirrors multica's unconditional goroutine).
  const done = (async (): Promise<AgentResult> => {
    const proc = spawn(execPath, args, {
      cwd: opts.cwd,
      env: buildChildEnv(cfg.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    log.info(`${agentName} spawn`, { exec: execPath, args, cwd: opts.cwd })

    let stderrTail = ''

    // Spawn failure (ENOENT: binary missing, EACCES, …). Without this handler
    // Node raises it as an uncaughtException. Record a failed result; the
    // 'error' event also drives stdout to EOF, so the readline loop ends on
    // its own. Do NOT destroy stdout here — destroying it rejects the readline
    // async iterator, which throws out of the `for await` and hangs `done`.
    proc.on('error', (err) => {
      log.error(`${agentName} spawn error`, { error: err.message })
      state.finalStatus = 'failed'
      state.finalError = `${agentName} spawn failed: ${err.message}`
    })
    // EPIPE on stdin/stdout happens when the child exits before we finish
    // writing (e.g. it crashed on startup). Swallow — the exit code / close
    // path is the authoritative failure signal.
    proc.stdin?.on('error', () => {})
    proc.stdout?.on('error', () => {})

    // Hoisted BEFORE the readline loop: on ENOENT the 'error' event fires on
    // the next tick, while the readline for-await is still running. Registering
    // both listeners here guarantees the race resolves no matter which fires.
    const exitCode = new Promise<number | null>((resolve) => {
      proc.once('close', resolve)
      proc.once('error', () => resolve(null))
    })

    proc.stderr!.on('data', (d: Buffer) => {
      const s = d.toString()
      log.warn(`${agentName} stderr`, { chunk: s.slice(-512) })
      stderrTail = (stderrTail + s).slice(-STDERR_TAIL_BYTES)
    })

    // Wall-clock timeout + inactivity watchdog. SIGTERM lets the CLI flush;
    // if it ignores SIGTERM, escalate to SIGKILL after a grace period.
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let inactivityTimer: NodeJS.Timeout | undefined
    let timedOut = false
    let stalled = false

    // SIGTERM → SIGKILL after the grace period. Shared by both watchdogs.
    // Idempotent: a second call when the proc is already dead is a no-op.
    const killWithEscalation = (): void => {
      proc.kill('SIGTERM')
      if (killTimer) clearTimeout(killTimer)
      // Freeze the inactivity watchdog once we've begun escalating: a late
      // line flushed during the SIGTERM grace must not re-arm it.
      if (inactivityTimer) {
        clearTimeout(inactivityTimer)
        inactivityTimer = undefined
      }
      killTimer = setTimeout(() => {
        // `proc.killed` only means "we already called kill()", NOT "the process
        // is dead". Always escalate: SIGKILL on an already-exited process is a
        // harmless no-op. (We do NOT destroy stdout — destroying it rejects the
        // readline iterator and hangs `done`; SIGKILL closes the child's stdout
        // end, which drives ours to EOF and ends the loop cleanly.)
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
    // merely for running long — only a truly silent one trips it.
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

    // Write the prompt and signal EOF (stdin mode). `end(chunk)` handles
    // backpressure internally; write errors are swallowed by the stdin
    // 'error' handler. For argv mode the prompt is already in args — still
    // close stdin so children that wait for stdin EOF before acting don't
    // hang until the inactivity watchdog (2026-08-16).
    if (inputMethod === 'stdin') {
      proc.stdin!.end(stdinPayload)
    } else {
      proc.stdin?.end()
    }

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity })
    try {
      // No short-circuit on spawn failure: on ENOENT the 'error' event fires
      // AND Node still drives stdout to EOF, so the loop naturally receives no
      // lines and falls through to the close-await.
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let events: AgentEvent[]
        try {
          events = parseLine(trimmed, state)
        } catch {
          // A parse failure (non-JSON line, unexpected shape) is surfaced as a
          // log event — the line still counts as activity (proves the child is
          // alive), matching claude.ts's non-JSON handling.
          queue.push({ type: 'log', content: trimmed })
          resetInactivity()
          continue
        }

        for (const ev of events) {
          queue.push(ev)
        }

        // Every parsed line resets the inactivity watchdog: a run that keeps
        // emitting (even slowly) is alive; only a truly silent one trips it.
        resetInactivity()
      }
    } finally {
      rl.close()
    }

    // Resolve on close (normal exit) OR a spawn error (ENOENT).
    const code = await exitCode
    if (timer) clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    if (inactivityTimer) clearTimeout(inactivityTimer)

    // Precedence: total-budget timeout beats silence; both beat a non-zero
    // exit. A run that hit the inactivity watchdog resolves `aborted`.
    if (timedOut) {
      state.finalStatus = 'timeout'
      state.finalError = `${agentName} timed out after ${opts.timeoutMs}ms`
    } else if (stalled) {
      state.finalStatus = 'aborted'
      state.finalError = `${agentName} stalled: no output for ${opts.inactivityTimeoutMs}ms`
    } else if (code !== 0 && code !== null && state.finalStatus === 'completed') {
      state.finalStatus = 'failed'
      state.finalError = `${agentName} exited with code ${code}`
    }
    if (state.finalError && stderrTail) {
      state.finalError = `${state.finalError}\n--- ${agentName} stderr (tail) ---\n${stderrTail}`
    }

    return {
      status: state.finalStatus,
      output: state.output,
      error: state.finalError,
      durationMs: Date.now() - startedAt,
      sessionId: state.sessionId,
      usage: state.usage,
    }
  })().finally(async () => {
    // Run the adapter's cleanup (e.g. remove MCP temp file) after the run
    // settles (success OR failure). Swallow errors: cleanup must never turn
    // a success into a rejection.
    if (cleanup) {
      try {
        await cleanup()
      } catch {
        // Swallow: best-effort cleanup.
      }
    }
  })

  // Close the events queue once the run is over (resolve OR reject) so the
  // consumer drains the buffer then sees EOF instead of hanging.
  void done.then(
    () => queue.close(),
    () => queue.close(),
  )

  return { events: queue, result: done }
}
