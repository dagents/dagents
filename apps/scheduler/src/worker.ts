import type { RedisClient, Logger } from '@mil/shared'
import { createLogger, getTracer } from '@mil/shared'
import { context, trace } from '@opentelemetry/api'
import { parseScheduleTask, TASK_QUEUE_KEY, type ScheduleTask } from './queue.js'
import type { PredictionClient, PredictionResult } from './prediction-client.js'
import type { ReproClient } from './repro-client.js'
import type { Semaphore } from './semaphore.js'
import { createRun, markRunning, completeRun, failRun, closeParentIfSettled } from './runs-repo.js'
import { ingestNodeSpansBestEffort } from './node-span-ingest.js'

/**
 * Scheduler worker (plan M3.1 / P1.7): consume the Redis task queue and run
 * each task through Flowise under a concurrency gate.
 *
 * ## Concurrency model — acquire *before* dequeue
 *
 * The semaphore bounds in-flight runs. A naïve loop would BRPOP a task first
 * and *then* try to acquire a slot — but that dequeues work it cannot start
 * yet, losing the task if the process crashes before a slot opens. Instead we
 * acquire a slot *first* (waiting until one is free), and only then BRPOP a
 * task. This guarantees a dequeued task always has a slot to run in, so no
 * task is orphaned by a crash, and the queue is the single source of pending
 * work (M3.5 restart re-scans the queue + `runs` table, not in-memory state).
 *
 * Each iteration: `semaphore.acquire()` (poll until a slot opens) →
 * `BRPOP tasks` (blocks) → run → `semaphore.release()`. When `maxConcurrent`
 * workers hit the cap, excess workers park on `acquire()` until a running task
 * releases.
 *
 * ## Concurrency gate — two paths, one `mil:sem`
 *
 * M3.2's HTTP fan-out and M3.1's queue worker share a single Redis key
 * `mil:sem` (main's `createRedisSemaphore`, Lua INCR/DECR counter). The
 * semaphore here is the *same* `Semaphore` interface the fan-out path uses
 * (`acquire()`/`release()`), so a worker process and a fan-out request pool
 * their slots against one counter. The worker blocks on `acquire()` via its
 * own bounded poll loop: the semaphore's `acquire()` is non-blocking (it
 * returns immediately when the gate is full), so the worker supplies the wait
 * itself and re-checks `stop()` between polls — `acquire()` takes no timeout
 * argument, so this loop is how we stay shutdown-responsive.
 *
 * ## Backpressure
 *
 * Because slots gate dequeue, the worker naturally applies backpressure: if
 * Flowise is slow, slots stay checked out, BRPOP stops draining, and the Redis
 * list grows — exactly the desired buffer. Producers see a growing queue, not
 * an unbounded fan-out.
 *
 * ## Graceful shutdown
 *
 * `stop()` flips a flag so the BRPOP/acquire loops exit at their next tick
 * (the BRPOP and acquire-poll both use short timeouts precisely so a shutdown
 * isn't held hostage by a long blocking call). In-flight runs are awaited via
 * `await Promise.allSettled` so a SIGTERM doesn't truncate a run mid-prediction.
 */

/** How long a single BRPOP waits before looping to re-check `running`. */
const BRPOP_TIMEOUT_SECONDS = 1
/** How long the acquire-poll sleeps before retrying when the gate is full. */
const ACQUIRE_POLL_MS = 10

export interface WorkerDeps {
  redis: RedisClient
  /** Shared concurrency gate (`mil:sem`); same instance the fan-out path uses. */
  semaphore: Semaphore
  /** Gateway-facing prediction client (single-run path posts one prediction). */
  prediction: PredictionClient
  /**
   * Optional repro integration (M4.2): when present, each dequeued run is
   * snapshotted + bound inline and its output archived on completion. Absent →
   * the M3.1 behavior is preserved, so worker tests that don't pass `repro`
   * keep working unchanged.
   */
  repro?: ReproClient
  logger?: Logger
}

export interface Worker {
  /** Resolve when the loop has stopped and all in-flight runs have settled. */
  stop(): Promise<void>
  /** True while the loop is still running. */
  isRunning(): boolean
}

interface InFlight {
  promise: Promise<void>
}

export function startWorker(deps: WorkerDeps): Worker {
  const log = deps.logger ?? createLogger({ svc: 'scheduler:worker' })
  let running = true
  // In-flight runs keyed by a monotonic id, so stop() can await them. The
  // `Semaphore` interface returns no token from `acquire()` (it is a counting
  // counter, not a token list), so we key on our own counter instead of an
  // acquired token — the slot itself is tracked by the semaphore's counter.
  let nextId = 0
  const inFlight = new Map<number, InFlight>()
  // Tracks the single BRPOP loop so stop() can wait for it to actually exit
  // (rather than racing the flag flip).
  let loopDone: Promise<void> | null = null

  const loop = async (): Promise<void> => {
    while (running) {
      // Acquire a slot BEFORE dequeuing — see module doc. The semaphore's
      // `acquire()` is non-blocking, so poll until a slot opens, re-checking
      // `running` between attempts so shutdown is responsive.
      let acquired = false
      while (running) {
        const r = await deps.semaphore.acquire()
        if (r.acquired) {
          acquired = true
          break
        }
        await sleep(ACQUIRE_POLL_MS)
      }
      if (!acquired) {
        // Shutdown landed while polling for a slot — no slot held, just exit.
        break
      }
      if (!running) {
        // Shutdown landed right after acquire — release the unused slot back.
        await deps.semaphore.release()
        break
      }

      // We hold a slot; BRPOP a task. Short timeout so shutdown is responsive
      // even when the queue is empty (otherwise BRPOP would block forever and
      // hold the slot hostage, defeating backpressure on shutdown).
      const raw = await deps.redis.brpop(TASK_QUEUE_KEY, BRPOP_TIMEOUT_SECONDS)
      if (raw === null) {
        // Queue empty within the window — release the slot and loop. This is
        // the idle path: no work, no slot held, ready for the next enqueue.
        await deps.semaphore.release()
        continue
      }

      // We have a task and a slot — run it. `runTask` owns the slot release.
      const id = nextId++
      const p = runTask(raw, deps, log).catch((err) => {
        // runTask already stamps the run failed + releases the slot; this catch
        // is a backstop so a thrown error never rejects the in-flight tracker.
        log.error('runTask threw unexpectedly', { error: String(err) })
      })
      inFlight.set(id, { promise: p })
      // Drop the entry once settled so the map doesn't grow unbounded.
      void p.finally(() => inFlight.delete(id))
    }
  }

  loopDone = loop()

  return {
    isRunning: () => running,
    stop: async () => {
      if (!running) return
      running = false
      // Wait for the dequeue loop to observe the flag and exit.
      await loopDone
      // Await any runs still mid-prediction so SIGTERM doesn't truncate them.
      await Promise.allSettled([...inFlight.values()].map((f) => f.promise))
    },
  }
}

/**
 * Execute a single dequeued task end-to-end: parse → create run → mark running
 * → call Flowise → stamp completed/failed → release the slot.
 *
 * The slot is released in a `finally` so it is always returned to the
 * pool, even when the run fails or the Flowise call throws — a leaked slot
 * would permanently shrink the concurrency cap.
 */
async function runTask(
  raw: string,
  deps: WorkerDeps,
  log: Logger,
): Promise<void> {
  let task: ScheduleTask | null = null
  try {
    task = parseScheduleTask(JSON.parse(raw))
  } catch {
    task = null
  }

  if (task === null) {
    log.warn('dropping malformed queue payload', { raw })
    await deps.semaphore.release()
    return
  }

  const { runId, pipelineId, input } = task

  // M6.1: wrap the run in a span tagged `run.id` so the prediction hop (and
  // its gateway→flowise→daemon→LLM downstream) join one trace. The undici
  // instrumentation injects `traceparent` into the outbound fetch from the
  // active span; `currentRunId()` reads `run.id` back for log correlation.
  const tracer = getTracer('scheduler')
  const span = tracer.startSpan('scheduler.run', {
    attributes: { 'run.id': runId, 'pipeline.id': pipelineId },
  })
  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await runTaskInner(raw, deps, log, runId, pipelineId, input)
    } finally {
      span.end()
    }
  })
}

/**
 * Inner run body (M6.1 factored out of `runTask` so the run-entry span wraps the
 * whole hop). Lifecycle + bookkeeping are unchanged from the pre-M6.1 inline
 * implementation.
 */
async function runTaskInner(
  _raw: string,
  deps: WorkerDeps,
  log: Logger,
  runId: string,
  pipelineId: string,
  input: unknown,
): Promise<void> {
  // M4.2: snapshot the flow for this run and bind it inline. The queue task
  // carries no caller-supplied hash (a queued task is `{ runId, pipelineId,
  // input }` — see queue.ts), so the worker always snapshots itself (the "hash
  // 缺省则 scheduler 自快照" path). Best-effort: a snapshot failure leaves the
  // run unbound (hash=null) and the run still executes.
  // M6.6: the runId threads into the snapshot so its version-lock audit row is
  // bound to this run (the audit is fire-and-forget inside the repro client).
  const versionHash =
    deps.repro != null ? await deps.repro.snapshotPipeline(pipelineId, runId) : null

  try {
    // Idempotent: ON CONFLICT DO NOTHING keeps a re-enqueued/recovered task
    // safe (M3.5). The producer mints the runId so it can correlate the queued
    // task with the run record from enqueue time. The version hash is bound
    // inline here (one INSERT writes row + hash together).
    await createRun({
      id: runId,
      identifier: runId,
      pipelineId,
      input,
      pipelineVersionHash: versionHash,
    })
    await markRunning(runId)
    log.info('run started', { runId, pipelineId, bound: versionHash !== null })

    const start = Date.now()
    let result: PredictionResult
    try {
      result = await deps.prediction.predict({ flowId: pipelineId, body: input }, runId)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - start
      // Best-effort: createRun above may have raced; re-insert (idempotent) so a
      // failure before the row existed is still recorded. Keep the same version
      // hash on the re-insert so a run that failed pre-row is still bound.
      await createRun({
        id: runId,
        identifier: runId,
        pipelineId,
        input,
        pipelineVersionHash: versionHash,
      }).catch(() => undefined)
      await failRun(runId, reason)
      log.error('run failed', { runId, pipelineId, reason, durationMs })
      return
    }

    const durationMs = Date.now() - start
    await completeRun(runId, {
      output: result.output,
      durationMs,
    })
    log.info('run completed', { runId, pipelineId, durationMs })

    // M4.2: archive the run's output. Best-effort — a failed archive (MinIO
    // down) leaves `artifact_uri` null and never re-fails the run. Only a
    // completed run has a real artifact; the failed branch above returns before
    // reaching here (a failed run records `{ error }`, not a real artifact).
    if (deps.repro) {
      await archiveBestEffort(deps.repro, runId, result.output, log)
    }

    // M6.4: ingest the run's node-level trace. The agentflow prediction
    // response carries `agentFlowExecutedData` (Flowise's per-node trace), so
    // the scheduler projects it into `run_node_spans` for the AgentFlows browse
    // page. Best-effort + best-effort-only: a failure logs and never re-fails
    // the (already completed) run — node-level trace is an observability
    // projection, not a run-lifecycle concern (same posture as the archive
    // hook above). `ingestNodeSpansBestEffort` defaults `traceId` to the active
    // span's traceId (M6.1, this run runs inside `scheduler.run` span) and
    // `finishedAt` to now — wiring the M6.1↔M6.4 end-to-end trace correlation
    // + the inspector's per-node finished timestamp without per-call plumbing.
    await ingestNodeSpansBestEffort({
      runId,
      flowId: pipelineId,
      output: result.output,
      logger: log,
    })
  } catch (err) {
    // A bookkeeping failure (DB down mid-run). Record the failure if we can,
    // but never swallow the slot release below.
    const reason = err instanceof Error ? err.message : String(err)
    log.error('run bookkeeping failed', { runId, pipelineId, error: reason })
    await failRun(runId, reason).catch(() => undefined)
  } finally {
    await deps.semaphore.release()
    // Batch parent close — worker hook arm (M3.6): a recovered fan-out child
    // just settled; if it was the last in-flight child of a parent still
    // `pending` (the killed-mid-batch case — `fanOut`'s `completeParentRun`
    // never ran), close that parent now so the batch is queryable as "done".
    // No-op for a parentless (single queue) run or a parent already closed.
    // Best-effort: a failure here never re-opens a settled child or leaks the
    // already-released slot — the next restart's boot sweep re-attempts the
    // close, so we only lose closing it *this* boot.
    try {
      const closed = await closeParentIfSettled(runId)
      if (closed) {
        log.info('parent closed after child settled', { runId, parentRunId: closed })
      }
    } catch (err) {
      log.warn('parent close hook failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Best-effort archive: never throws, logs on failure. See `repro-client.ts`. */
async function archiveBestEffort(
  repro: ReproClient,
  runId: string,
  output: unknown,
  log: Logger,
): Promise<void> {
  try {
    await repro.archiveArtifact(runId, output)
  } catch (err) {
    log.warn('archive hook threw unexpectedly', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
