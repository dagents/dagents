/**
 * `runDaemon` — the local long-lived daemon main loop (plan M2.3).
 *
 *   register → heartbeat loop → poll claim → execute → report → complete/fail
 *
 * The daemon is pull-based: it claims work from dispatch over HTTP rather than
 * receiving pushes. One backend per agent type serves all tasks that daemon
 * advertised at registration; for MVP the daemon advertises exactly one
 * capability and maps it 1:1 to an `@dagents/agent-adapters` backend.
 *
 * Robustness notes (the plan's skeleton loop had none of these):
 *   - Errors during one task never kill the daemon — a failure is reported
 *     via `failTask` and the loop continues. Only `register` failing is fatal.
 *   - Heartbeat runs on its own interval with its own try/catch; a transient
 *     dispatch outage degrades to heartbeat retries, not a crash.
 *   - `reportMessages` is best-effort per event batch — if dispatch is briefly
 *     down mid-run we log and keep streaming so the agent isn't blocked, then
 *     the terminal `completeTask`/`failTask` carries the authoritative result.
 *   - SIGINT/SIGTERM trigger a single graceful drain: stop claiming new tasks,
 *     let the in-flight task finish, then exit. This is the bare minimum the
 *     Gate-1 e2e (M2.4) needs to be restartable without losing a run.
 */
import { DispatchClient, DispatchHttpError } from './client.js'
import { claudeBackend } from '@dagents/agent-adapters'
import { context, trace } from '@opentelemetry/api'
import { createLogger, getTracer, type Logger } from '@dagents/shared'
import type { AgentBackend, AgentResult, AgentType, ExecOptions } from '@dagents/contracts'

/**
 * A 409 from a terminal endpoint means the task is already `completed` or
 * `failed` (duplicate claim, cancelled, or a late report racing with a prior
 * terminal call). It is the expected "nothing to do" signal, not an error —
 * callers swallow it and move on so a re-claimed or raced task doesn't wedge
 * the daemon or double-report.
 */
function isTerminalConflict(err: unknown): boolean {
  return err instanceof DispatchHttpError && err.status === 409
}

export interface DaemonOpts {
  /** Dispatch server base URL, e.g. `http://localhost:8081`. */
  serverUrl: string
  /** Human-readable label for this daemon (logged, stored on the daemons row). */
  label: string
  /** Agent type this daemon serves (MVP: exactly one capability). */
  agentType: AgentType
  /** Claim poll interval (ms). Default 2000. */
  pollIntervalMs?: number
  /** Heartbeat interval (ms). Default 5000. */
  heartbeatIntervalMs?: number
  /** Injectable dispatch client (tests inject a mock). */
  client?: DispatchClient
  /** Injectable backend factory (tests inject a fake; default builds claudeBackend). */
  backendFactory?: (agentType: AgentType) => AgentBackend
  /** Injectable logger. */
  logger?: Logger
  /** Path to the agent executable; defaults to the agentType name. */
  executablePath?: string
}

export interface DaemonHandle {
  /** Resolves when the daemon drains and exits (graceful or fatal register failure). */
  done: Promise<void>
  /** Request a graceful drain-and-exit (SIGINT/SIGTERM handler calls this). */
  stop: () => void
}

/** Build the agent backend for a given type. MVP only supports `claude`. */
export function defaultBackendFactory(
  agentType: AgentType,
  executablePath: string,
  logger: Logger,
): AgentBackend {
  // Only the claude adapter exists in @dagents/agent-adapters today (M2.1).
  // Codex/opencode/… land with their own tasks; until then a daemon started
  // for any non-claude type fails loudly at execute time, not silently.
  if (agentType !== 'claude') {
    throw new Error(
      `unsupported agentType '${agentType}': only 'claude' has an adapter in @dagents/agent-adapters (M2.1). ` +
        `Other backends arrive in their own tasks.`,
    )
  }
  return claudeBackend({ executablePath, logger })
}

export function runDaemon(opts: DaemonOpts): DaemonHandle {
  const log: Logger = opts.logger ?? createLogger({ svc: 'daemon', label: opts.label })
  const pollIntervalMs = opts.pollIntervalMs ?? 2000
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 5000
  const executablePath = opts.executablePath ?? opts.agentType

  const client = opts.client ?? new DispatchClient({ baseUrl: opts.serverUrl, logger: log })
  const backendFactory =
    opts.backendFactory ?? ((t: AgentType) => defaultBackendFactory(t, executablePath, log))

  // `draining` flips to true on stop(); the poll loop stops claiming new work
  // and the loop exits once the in-flight task (if any) finishes.
  let draining = false
  let heartbeatTimer: NodeJS.Timeout | undefined
  let inFlight = false

  const stop = (): void => {
    if (draining) return
    draining = true
    log.info('daemon drain requested', { inFlight })
  }

  const done = (async (): Promise<void> => {
    // ── register ────────────────────────────────────────────────────────
    let daemonId: string
    try {
      const reg = await client.register({
        daemonLabel: opts.label,
        capabilities: [{ agentType: opts.agentType }],
      })
      client.setToken(reg.token)
      daemonId = reg.daemonId
      log.info('daemon registered', { daemonId, agentType: opts.agentType })
    } catch (err) {
      // Register failing is fatal — without a daemonId we can't claim or
      // heartbeat. Surface and exit (the supervisor / user will restart).
      log.error('daemon register failed, exiting', { error: String(err) })
      return
    }

    // ── heartbeat loop ──────────────────────────────────────────────────
    heartbeatTimer = setInterval(() => {
      client
        .heartbeat({ daemonId, status: draining ? 'draining' : 'online', activeTasks: inFlight ? 1 : 0 })
        .catch((err) => log.warn('heartbeat failed', { error: String(err) }))
    }, heartbeatIntervalMs)
    // setInterval keeps the event loop alive; unref so tests / signal-driven
    // shutdown aren't held open by a pending heartbeat alone.
    heartbeatTimer.unref?.()

    // ── claim poll loop ─────────────────────────────────────────────────
    while (!draining) {
      let claimed
      try {
        claimed = await client.claimTask(daemonId)
      } catch (err) {
        // A transient dispatch error during claim is recoverable — back off
        // and retry the next tick rather than crashing the daemon.
        log.warn('claim failed, backing off', { error: String(err) })
        await sleep(pollIntervalMs)
        continue
      }

      const task = claimed.task
      if (!task) {
        await sleep(pollIntervalMs)
        continue
      }

      log.info('claimed task', { taskId: task.id, runId: task.runId })
      inFlight = true
      // M6.1: wrap the task execution in a span carrying `run.id` + `task.id`,
      // so the daemon's dispatch + gateway + LLM hops join the run's trace.
      // The undici instrumentation injects `traceparent` into every outbound
      // `fetch` the daemon makes (startTask / reportMessages / completeTask)
      // from this active span.
      const tracer = getTracer('daemon')
      const taskSpan = tracer.startSpan('daemon.execute', {
        attributes: { 'task.id': task.id, 'run.id': task.runId },
      })
      try {
        await context.with(trace.setSpan(context.active(), taskSpan), () =>
          executeTask(client, backendFactory(opts.agentType), task.id, task.runId, task.prompt, task.execOptions, log),
        )
      } catch (err) {
        // `executeTask` reports failures via `failTask` internally, but this
        // outer catch also covers the case `executeTask`'s comment got wrong:
        // `backendFactory(opts.agentType)` is evaluated as an argument before
        // `executeTask` runs, so a factory throw (unsupported agentType, spawn
        // config error) lands here — where `failTask` was never attempted. With
        // no dispatch reaper (confirmed: claim only selects `status='queued'`),
        // such a task would sit in `claimed` forever. Fall back to `failTask`
        // so the task is visible and re-runnable; a 409 means it was already
        // terminal (raced/cancelled) and is the expected no-op.
        log.error('task execution blew up unexpectedly', { taskId: task.id, error: String(err) })
        try {
          await client.failTask(task.id, {
            error: err instanceof Error ? err.message : String(err),
            failureReason: 'daemon_error',
          })
        } catch (failErr) {
          if (!isTerminalConflict(failErr)) {
            log.warn('failTask fallback failed', { taskId: task.id, error: String(failErr) })
          }
        }
      } finally {
        taskSpan.end()
        inFlight = false
      }
    }

    // ── graceful drain ──────────────────────────────────────────────────
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    log.info('daemon drained, exiting', { daemonId })
  })()

  // Surface unexpected rejections from the loop as a logged error rather than
  // an unhandled-rejection crash; `done` already resolves on graceful exit.
  done.catch((err) => log.error('daemon loop crashed', { error: String(err) }))

  return { done, stop }
}

/**
 * Run one task to completion against the backend, streaming events to dispatch
 * and reporting the terminal result. All dispatch errors inside are caught:
 * `failTask` is the last resort when the agent itself errors or the backend
 * throws before producing a result.
 */
async function executeTask(
  client: DispatchClient,
  backend: AgentBackend,
  taskId: string,
  runId: string,
  prompt: string,
  execOptions: unknown,
  log: Logger,
): Promise<void> {
  // exec_options is stored as JSONB; trust the shape at the boundary but
  // default to {} so a null/missing column can't crash the backend.
  const opts: ExecOptions = (execOptions as ExecOptions) ?? {}

  try {
    await client.startTask(taskId)
  } catch (err) {
    // `start` is advisory (it stamps status='running'); a 409 means the task
    // was already terminal (duplicate claim / cancelled) — bail out cleanly.
    if (isTerminalConflict(err)) {
      log.warn('startTask hit terminal conflict; skipping task', { taskId })
      return
    }
    // Any other startTask failure (404 gone, 422 bad shape, 5xx, timeout):
    // the task is already `claimed` (claim just moved it queued→claimed), and
    // dispatch has no reaper, so without a `failTask` here it would orphan in
    // `claimed` and never be re-runnable. Mark it failed so it stays visible.
    log.warn('startTask failed; failing task to avoid orphan', { taskId, error: String(err) })
    try {
      await client.failTask(taskId, {
        error: err instanceof Error ? err.message : String(err),
        failureReason: 'daemon_error',
      })
    } catch (failErr) {
      if (!isTerminalConflict(failErr)) {
        log.error('failTask after startTask failure also failed', { taskId, error: String(failErr) })
      }
    }
    return
  }

  const session = backend.execute(prompt, opts)

  // M6.1: tag the active span with the task's run id so the daemon hop
  // (daemon→dispatch→gateway→LLM) joins the same trace the run started
  // upstream. `currentRunId()` then reads `run.id` back for log correlation.
  // The span was opened by the caller; we only attach the attribute here.
  const activeSpan = trace.getSpan(context.active())
  activeSpan?.setAttribute('run.id', runId)

  try {
    // Stream events to dispatch as they arrive. Batch size = 1 per the plan;
    // reportMessages accepts an array so a future batched-buffer optimization
    // is a local change to this loop only.
    for await (const ev of session.events) {
      try {
        await client.reportMessages(taskId, [ev])
      } catch (err) {
        // Don't let a transient dispatch outage abort the agent run — log and
        // keep streaming. The terminal result is what's authoritative.
        log.warn('reportMessages failed; continuing', { taskId, error: String(err) })
      }
    }

    const result: AgentResult = await session.result
    if (result.status === 'completed') {
      await client.completeTask(taskId, {
        output: result.output,
        sessionId: result.sessionId,
        usage: result.usage,
        durationMs: result.durationMs,
      })
      log.info('task completed', {
        taskId,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        models: Object.keys(result.usage),
      })
    } else {
      await client.failTask(taskId, {
        error: result.error ?? `agent ${result.status}`,
        failureReason: result.status,
        sessionId: result.sessionId,
      })
      log.warn('task failed', { taskId, status: result.status, error: result.error })
    }
  } catch (err) {
    // Backend threw before yielding a result (spawn error, parse crash, …).
    // Report failure and let the caller continue to the next task.
    const message = err instanceof Error ? err.message : String(err)
    try {
      await client.failTask(taskId, { error: message, failureReason: 'daemon_error' })
    } catch (failErr) {
      log.error('failTask also failed', { taskId, error: String(failErr) })
    }
    log.error('task threw', { taskId, error: message })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
