import { context, trace } from '@opentelemetry/api'
import { createLogger, getTracer } from '@mil/shared'
import { runQuery } from '@mil/db'
import type { PredictionClient, PredictionResult } from './prediction-client.js'
import { PredictionError } from './prediction-client.js'
import type { ReproClient } from './repro-client.js'
import type { Semaphore } from './semaphore.js'
import {
  completeParentRun,
  completeRun,
  createRun,
  failRun,
  markRunning,
  type ParentAggregate,
} from './runs-repo.js'
import { ingestNodeSpansBestEffort } from './node-span-ingest.js'

/**
 * Batch fan-out (P1.7.T4 / plan M3.2).
 *
 * Flowise Iteration processes arrays serially, so for throughput-sensitive
 * batches ("run N papers through a flow") the scheduler fans the batch out
 * itself (architecture v0.2 §6.5): one parent run + N child runs, each child a
 * single Prediction API call, executed concurrently up to the semaphore's
 * `maxConcurrent`. The parent aggregates child outcomes once every child has
 * settled (success or failure).
 *
 * Shape of a fan-out:
 *   1. create parent run (status=pending, input = the whole batch)
 *   2. for each input: create a child run (parent_run_id = parent id)
 *   3. concurrently, each child: markRunning → semaphore.withSlot → predict
 *      → completeRun / failRun
 *   4. completeParentRun aggregates children into the parent's output and
 *      closes the parent (completed iff all children completed)
 *
 * Concurrency note: all child promises are started immediately (Promise.all),
 * but the Prediction API hop inside each is gated by the semaphore. This
 * separates "start the bookkeeping for N children" (cheap, unbounded) from
 * "spend an upstream prediction slot" (expensive, bounded) — so a batch of 50
 * with maxConcurrent=5 creates 50 rows fast, then drains predictions 5 at a
 * time. A child that throws *outside* the Prediction call (e.g. a DB write
 * failure) is caught per-child so one bad row can't abort the whole batch;
 * such a child is marked failed and the parent still aggregates.
 */

const log = createLogger({ svc: 'scheduler:fanout' })

export interface FanOutInputItem {
  /** Per-child input shipped to Flowise as the prediction body. */
  body: unknown
  /** Optional human label for the child run's `identifier`. */
  label?: string
}

export interface FanOutRequest {
  /** Flowise flow id each child predicts against. */
  flowId: string
  /** The batch — one child run per item. */
  inputs: FanOutInputItem[]
  /** Shared run metadata. */
  pipelineId: string
  identifier: string
  workspaceId?: string | null
  pipelineVersionHash?: string | null
  createdByUserId?: string | null
}

export interface FanOutChildResult {
  runId: string
  status: 'completed' | 'failed'
  output: unknown
  durationMs: number
}

export interface FanOutResult {
  parentRunId: string
  total: number
  completed: number
  failed: number
  children: FanOutChildResult[]
  aggregate: ParentAggregate
}

export interface FanOutDeps {
  prediction: PredictionClient
  semaphore: Semaphore
  /**
   * Optional repro integration (M4.2): when present, the fan-out snapshots the
   * flow once (unless the caller already passed a `pipelineVersionHash`), binds
   * parent + every child inline via `createRun`, and archives each child's
   * output + the parent's aggregate. Absent → the M3.2 behavior (no snapshot /
   * bind / archive) is preserved, so worker/M3.6 tests that don't pass `repro`
   * keep working unchanged.
   */
  repro?: ReproClient
}

/**
 * Execute a batch fan-out. Creates the parent run, fans out N children under
 * the concurrency gate, then aggregates. Never throws on a child prediction
 * failure — that child is recorded `failed` and the parent still completes
 * (with status `failed` if any child failed). Only throws on parent/child
 * *row creation* failure, which means the batch could not even be recorded.
 */
export async function fanOut(req: FanOutRequest, deps: FanOutDeps): Promise<FanOutResult> {
  if (req.inputs.length === 0) {
    throw new Error('fanOut: inputs must be non-empty')
  }

  // M4.2: snapshot the flow ONCE for the whole batch and bind parent + every
  // child to that version. The snapshot is content-addressed (UNIQUE on
  // version_hash), so re-snapshots of an unchanged flow are a no-op — but it
  // still costs an upstream flow-fetch. If the caller already knows the hash
  // (e.g. a caller that snapshotted itself, threaded via the HTTP body), use it
  // verbatim and skip the snapshot (architect refinement, 03:37: "hash 缺省则
  // scheduler 自快照"). Best-effort: a snapshot failure falls back to
  // `req.pipelineVersionHash` (the caller's, possibly null) so the batch still
  // runs — the runs land unbound rather than the whole batch failing.
  //
  // The parent run is created BEFORE the snapshot so its id can thread into the
  // snapshot's version-lock audit row (M6.6). Order matters: snapshot → parent
  // would leave the audit row unbound to a run id.
  const parent = await createRun({
    identifier: req.identifier,
    pipelineId: req.pipelineId,
    parentRunId: null,
    input: { flowId: req.flowId, inputs: req.inputs },
    pipelineVersionHash: null,
    workspaceId: req.workspaceId ?? null,
    createdByUserId: req.createdByUserId ?? null,
  })
  const hash = await resolveVersionHash(req, deps, parent.id)
  // Re-stamp the parent's hash now that the snapshot resolved. A null hash
  // (snapshot failed / caller gave none) leaves the parent unbound — same
  // outcome as before, just split across createRun + an UPDATE so the parent
  // id exists in time for the audit. The UPDATE is a no-op when hash is null.
  if (hash) {
    await runQuery(`UPDATE runs SET pipeline_version_hash = $2 WHERE id = $1`, [
      parent.id,
      hash,
    ])
  }
  log.info('fan-out version resolved', { flowId: req.flowId, bound: hash !== null })

  // 2. + 3. create each child, then run all concurrently (gate inside). Same
  // hash threads into every child's `createRun` — one snapshot covers the batch.
  const children = await Promise.all(
    req.inputs.map(async (item, i): Promise<FanOutChildResult> => {
      const child = await createRun({
        identifier: item.label ?? `${req.identifier}#${i + 1}`,
        pipelineId: req.pipelineId,
        parentRunId: parent.id,
        input: item.body,
        pipelineVersionHash: hash,
        workspaceId: req.workspaceId ?? null,
        createdByUserId: req.createdByUserId ?? null,
      })

      return runChild(child.id, req.flowId, item.body, deps)
    }),
  )

  // 4. aggregate into the parent.
  const aggregate = await completeParentRun(parent.id)
  log.info('fan-out complete', {
    parentRunId: parent.id,
    total: aggregate.total,
    completed: aggregate.completed,
    failed: aggregate.failed,
  })

  // M4.2: archive the parent's aggregate output (audit). Best-effort: a failed
  // archive leaves `artifact_uri` null and never fails the (already-completed)
  // batch. The aggregate is the parent's `output`, which `completeParentRun`
  // just computed — re-using it avoids a second query.
  if (deps.repro) {
    await archiveBestEffort(deps.repro, parent.id, aggregate, log)
  }

  return {
    parentRunId: parent.id,
    total: children.length,
    completed: children.filter((c) => c.status === 'completed').length,
    failed: children.filter((c) => c.status === 'failed').length,
    children,
    aggregate,
  }
}

/**
 * Resolve the version hash for a batch. Snapshot only when the caller did not
 * supply one — a caller-supplied hash is used verbatim (the caller already paid
 * for the snapshot, or is reproducing a known version). When `repro` is absent
 * (M3.2 tests / a deployment without repro wired), the caller's hash (possibly
 * null) passes through unchanged: no snapshot, no binding change.
 *
 * M6.6: when the scheduler self-snapshots, the parent run id threads in so the
 * version-lock audit row is bound to the run that triggered the lock. (The
 * parent is created before the snapshot in `fanOut`, so its id is known here.)
 */
async function resolveVersionHash(
  req: FanOutRequest,
  deps: FanOutDeps,
  parentRunId: string | null,
): Promise<string | null> {
  if (req.pipelineVersionHash) return req.pipelineVersionHash
  if (!deps.repro) return req.pipelineVersionHash ?? null
  return deps.repro.snapshotPipeline(req.flowId, parentRunId, req.workspaceId ?? null)
}

/** Best-effort archive: never throws, logs on failure. See `repro-client.ts`. */
async function archiveBestEffort(
  repro: ReproClient,
  runId: string,
  output: unknown,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    await repro.archiveArtifact(runId, output)
  } catch (err) {
    // `archiveArtifact` already swallows store failures and returns null; this
    // catch is a backstop for anything unexpected so a repro bug can never fail
    // a completed run.
    log.warn('archive hook threw unexpectedly', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Run one child: running → gated predict → completed/failed. Isolated so a
 * prediction failure becomes a `failed` child row, not a thrown promise that
 * would abort `Promise.all` and orphan sibling children mid-flight.
 *
 * Exported (M3.4) so the rerun path reuses the exact same execution —
 * markRunning → semaphore.withSlot → predict → complete/fail — as a fresh
 * fan-out child, instead of the rerun layer re-implementing the lifecycle and
 * risking drift. The rerun layer creates its own `pending` run row first, then
 * hands the id here.
 */
export async function runChild(
  runId: string,
  flowId: string,
  body: unknown,
  deps: FanOutDeps,
): Promise<FanOutChildResult> {
  // M6.1: wrap the child run in a span tagged `run.id` so its prediction hop
  // (gateway→flowise→daemon→LLM) joins one trace. The undici instrumentation
  // injects `traceparent` from this active span into the outbound fetch.
  const tracer = getTracer('scheduler')
  const span = tracer.startSpan('scheduler.child-run', {
    attributes: { 'run.id': runId, 'flow.id': flowId },
  })
  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await runChildInner(runId, flowId, body, deps)
    } finally {
      span.end()
    }
  })
}

/** Inner child-run body (M6.1 factored out so the run-entry span wraps it). */
async function runChildInner(
  runId: string,
  flowId: string,
  body: unknown,
  deps: FanOutDeps,
): Promise<FanOutChildResult> {
  await markRunning(runId)

  let result: PredictionResult
  try {
    result = await deps.semaphore.withSlot(() =>
      deps.prediction.predict({ flowId, body }, runId),
    )
  } catch (err) {
    const message = err instanceof PredictionError ? err.message : String(err)
    log.warn('child prediction failed', { runId, error: message })
    await failRun(runId, message)
    return { runId, status: 'failed', output: { error: message }, durationMs: 0 }
  }

  await completeRun(runId, {
    output: result.output,
    durationMs: result.durationMs,
  })

  // M4.2: archive the child's output to object storage. Best-effort — a failed
  // archive (MinIO down) leaves `artifact_uri` null and never re-fails the run.
  // Only completed runs have a real output to archive; failed runs (handled in
  // the catch above) record `{ error }` and are not archived (no real artifact).
  if (deps.repro) {
    await archiveBestEffort(deps.repro, runId, result.output, log)
  }

  // M6.4: ingest the child run's node-level trace (agentflow prediction
  // response carries `agentFlowExecutedData`). Best-effort — a failure logs and
  // never re-fails the (already completed) child. The shared helper defaults
  // `traceId` to the active span's traceId (M6.1, this child runs inside the
  // `scheduler.child-run` span) and `finishedAt` to now, wiring the
  // M6.1↔M6.4 trace correlation + per-node finished timestamp.
  await ingestNodeSpansBestEffort({
    runId,
    flowId,
    output: result.output,
    logger: log,
  })

  return { runId, status: 'completed', output: result.output, durationMs: result.durationMs }
}
