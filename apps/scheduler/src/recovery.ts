import type { RedisClient, Logger } from '@mil/shared'
import { createLogger } from '@mil/shared'
import { runQuery } from '@mil/db'
import { TASK_QUEUE_KEY, type ScheduleTask } from './queue.js'
import type { Semaphore } from './semaphore.js'
import { completeParentRun, listSettledPendingParents } from './runs-repo.js'

/**
 * Restart recovery (plan M3.5 / P1.7.T8).
 *
 * When the scheduler process is killed mid-run, two pieces of in-memory /
 * Redis state are left dangling:
 *
 * - **Leaked semaphore slots** — the worker acquires a `mil:sem` slot *before*
 *   it dequeues (see `worker.ts`) and releases it in a `finally` once the run
 *   settles. A SIGKILL bypasses that `finally`, so the slot's INCR is never
 *   balanced by a DECR. The counter lives in Redis for the process lifetime,
 *   so on restart the gate starts `leaked` slots short of `maxConcurrent` —
 *   and across N crash-restart cycles the counter only climbs, eventually
 *   saturating at `maxConcurrent` and blocking all work. `resetSemaphore`
 *   clears it back to 0.
 * - **Stuck `running` runs** — `worker.runTask` flips a run to `running`
 *   (`markRunning`) before calling Flowise, and stamps it `completed`/`failed`
 *   only after the prediction returns. A kill between those leaves the row
 *   `running` forever: the queue task that started it was already BRPOP'd
 *   (BRPOP is atomic — the message is gone from `mil:tasks` the moment it was
 *   dequeued), so the worker will never pick it up again on its own.
 *   `listStaleRuns` finds these rows and `recoverStaleRuns` re-enqueues each
 *   as a fresh `ScheduleTask` so the worker re-runs it end to end.
 *
 * ## What gets recovered
 *
 * Only `status = 'running'` rows. A run reaches `running` exclusively via
 * `markRunning`, which the queue worker and the fan-out child path call —
 * never the fan-out *parent* (a parent goes `pending → completed|failed`
 * directly via `completeParentRun`). So scanning `running` naturally recovers
 * single (queue) runs and fan-out children, and never misfires on a parent
 * (whose `input` is the whole batch, not a valid single prediction body).
 *
 * Re-enqueue is idempotent: `worker.runTask` re-inserts the run with
 * `ON CONFLICT (id) DO NOTHING` (the row already exists, so the INSERT is a
 * no-op) and `markRunning`'s `WHERE status = 'pending'` guard means an
 * already-`running` row is not re-stamped (its `started_at` is preserved).
 * The prediction then re-executes and stamps the run terminal — the run
 * "resumes" by re-running from its persisted `input`.
 *
 * ## Batch parent close (M3.6)
 *
 * A `fanOut` closes its parent only after every child settles
 * (`completeParentRun`, called once at the end of `fanOut`). A SIGKILL before
 * that call — or with children still mid-prediction — orphans the parent in
 * `pending`: the children may all reach terminal (recovered + re-run, or
 * already terminal before the crash), but nothing on the restart path re-calls
 * `completeParentRun`, so the batch is "续跑完成" per-child but never "完成"
 * per-batch — the parent's `status` / `output` aggregate is lost. That breaks
 * the "批量可跑可查" half of the M3 contract under a crash.
 *
 * `recoverStaleRuns` closes this loop in two arms, so a batch left in *either*
 * crash state is queryable as "done" after a restart:
 *
 * - **Boot sweep** — parents whose children were *all terminal at boot* (the
 *   crash happened after every child had settled, before the parent close
 *   call). `listSettledPendingParents` finds these; we close each directly
 *   here. No child is re-enqueued — the work is done, only the parent close
 *   was missed.
 * - **Worker hook** — parents whose children were *still `running` at boot*.
 *   Those children are re-enqueued above and drained by the worker
 *   asynchronously; the parent can only be closed once the last recovered
 *   child settles, so `worker.runTask` calls `closeParentIfSettled` after
 *   each dequeued child completes (see `worker.ts`). This arm is what makes a
 *   mid-batch crash — the acceptance case — close the parent at all.
 *
 * Both arms funnel into `completeParentRun`, whose `status = 'pending'` guard
 * makes a double-close (boot sweep racing the worker hook across a shared
 * parent) a no-op for the loser.
 *
 * ## Single-instance assumption
 *
 * `resetSemaphore` clears the shared `mil:sem` key unconditionally — correct
 * for the MVP single-process scheduler, where the only holder of slots is the
 * process being (re)started. A multi-instance deployment (M3.3 `MODE=QUEUE`)
 * would need TTL/heartbeat-based slot expiry so one instance can't zero out
 * another's live slots; that is out of scope for M3.5.
 */

export interface StaleRun {
  id: string
  pipelineId: string
  input: unknown
}

/**
 * Load every run still marked `running`. Ordered by `started_at` (then
 * `created_at`) so recovery re-enqueues in the order runs originally started —
 * FIFO-ish fairness across a restart. `NULLS LAST` because a `running` row
 * without `started_at` (a bookkeeping race) sorts last either way.
 */
export async function listStaleRuns(): Promise<StaleRun[]> {
  const { records } = await runQuery<StaleRun>(
    `SELECT id, pipeline_id AS "pipelineId", input
       FROM runs
      WHERE status = 'running'
      ORDER BY started_at NULLS LAST, created_at`,
  )
  return records
}

/**
 * Clear the `mil:sem` counter so the restarted process starts with the full
 * `maxConcurrent` budget. The `Semaphore` interface exposes `reset()` (a raw
 * DEL on the prefixed key) for exactly this; wrapping it here keeps the
 * recovery module the single place that decides *when* a reset is safe.
 */
export async function resetSemaphore(semaphore: Semaphore): Promise<void> {
  await semaphore.reset()
}

export interface RecoverDeps {
  redis: RedisClient
  semaphore: Semaphore
  logger?: Logger
}

export interface RecoverResult {
  /** Number of stuck runs re-enqueued onto `mil:tasks`. */
  recovered: number
  /** The run ids that were re-enqueued, in enqueue order. */
  runIds: string[]
  /** True once the semaphore counter has been cleared. */
  semReset: boolean
  /**
   * Ids of fan-out parents closed by the boot sweep — parents left `pending`
   * by a mid-batch crash whose children were all already terminal at boot.
   * (Parents whose children were still `running` are closed later by the
   * worker hook, not counted here — see the module doc's "Batch parent
   * close" section.) Surfaced for logging/assertion; empty when nothing was
   * orphaned.
   */
  closedParents: string[]
}

/**
 * Restart recovery entry point: reset the leaked semaphore, scan for stuck
 * `running` runs, and re-enqueue each as a `ScheduleTask` the worker will
 * pick up. Safe to call on every boot — with no stale runs it is a no-op
 * (resets an already-zero counter and enqueues nothing).
 *
 * The semaphore is reset *before* the scan so the re-enqueued runs have the
 * full concurrency budget to drain into; resetting after would let the worker
 * (started next in `index.ts`) grab slots against a still-leaked counter.
 */
export async function recoverStaleRuns(deps: RecoverDeps): Promise<RecoverResult> {
  const log = deps.logger ?? createLogger({ svc: 'scheduler:recovery' })

  await resetSemaphore(deps.semaphore)

  const stale = await listStaleRuns()
  for (const run of stale) {
    const task: ScheduleTask = {
      runId: run.id,
      pipelineId: run.pipelineId,
      input: run.input ?? {},
    }
    // LPUSH matches the producer convention (FIFO under BRPOP). The worker's
    // parseScheduleTask validates the shape; a row with a non-object `input`
    // is forwarded verbatim — `input` is opaque to the scheduler.
    await deps.redis.lpush(TASK_QUEUE_KEY, JSON.stringify(task))
  }

  const runIds = stale.map((r) => r.id)

  // Batch parent close — boot sweep arm (M3.6): close parents left `pending`
  // by a mid-batch crash whose children were all terminal at boot. The
  // re-enqueued `running` children above are drained by the worker and their
  // parents closed via the worker hook; this sweep handles the parents whose
  // children needed no re-enqueue at all (the crash landed after the last
  // child settled, before the parent close call). Safe to run unconditionally:
  // empty when no parent is orphaned, and `completeParentRun`'s pending guard
  // makes it a no-op for any parent the worker hook already closed.
  const orphanedParents = await listSettledPendingParents()
  for (const parentId of orphanedParents) {
    await completeParentRun(parentId)
  }

  log.info('recovery complete', {
    recovered: stale.length,
    runIds,
    closedParents: orphanedParents,
  })
  return {
    recovered: stale.length,
    runIds,
    semReset: true,
    closedParents: orphanedParents,
  }
}
