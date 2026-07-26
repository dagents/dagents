import { createLogger } from '@dagents/shared'
import { runChild, type FanOutDeps } from './fanout.js'
import {
  createRerunRun,
  loadRunForRerun,
  type RerunSource,
} from './runs-repo.js'

/**
 * Failed-run rerun (P1.7.T5 / plan M3.4).
 *
 * "同一 pipeline_version_hash 重跑指定子 run" — re-execute one terminal run
 * (typically a failed fan-out child) against the same flow + input + version
 * hash so the outcome is comparable to the original. The new run is a sibling
 * of the source, not a mutation of it: the source row is left untouched
 * (provenance + comparability), and the rerun row carries `created_by_run_id`
 * = source id so the link is queryable.
 *
 * Why a sibling, not an in-place reset: the spec's repro contract (§4.4) is
 * "可重跑 + 可追溯 + 可比对" — rerun + traceable + comparable. Resetting the
 * source row in place would destroy the original outcome and break
 * comparability. A fresh row that copies `pipeline_version_hash` + `input` +
 * `parent_run_id` from the source preserves both the original and the
 * lineage, and reuses `runChild` so the execution path is identical to a
 * first-class fan-out child.
 *
 * Guard: only terminal runs (`completed` / `failed` / `cancelled`) may be
 * rerun. A `pending`/`running` run is in flight — rerunning it would race the
 * in-flight execution. Returns `RerunError` (→ 409 in the HTTP layer) so the
 * caller can poll and retry once the run settles.
 */

const log = createLogger({ svc: 'scheduler:rerun' })

/**
 * Raised when a rerun cannot proceed for a domain reason — source missing, or
 * source not in a terminal state. The HTTP layer maps `code` to a status:
 * `not_found` → 404, `in_flight` → 409. Infrastructure failures (DB / upstream
 * Prediction) are NOT `RerunError` — they throw through and surface as 502,
 * matching the fan-out route's convention.
 */
export type RerunErrorCode = 'not_found' | 'in_flight'

export class RerunError extends Error {
  constructor(
    public code: RerunErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RerunError'
  }
}

export interface RerunDeps extends FanOutDeps {}

export interface RerunResult {
  /** The new run id (the rerun), NOT the source. */
  runId: string
  /** The run that was rerun. */
  sourceRunId: string
  status: 'completed' | 'failed'
  output: unknown
  durationMs: number
}

/**
 * Rerun a single terminal run. Loads the source's comparable identity, creates
 * a new `pending` run with the same `pipeline_version_hash` + `input` +
 * `parent_run_id` (stamping `created_by_run_id` = source for provenance), then
 * executes it through the same `runChild` path a fan-out child uses.
 *
 * Never throws on a Prediction failure — the rerun run is marked `failed` and
 * returned with `status: 'failed'`, exactly mirroring how a fan-out child
 * records a prediction failure. Only throws `RerunError` (domain guard) or on
 * an infrastructure failure (DB write), which the HTTP layer turns into 502.
 */
export async function rerunRun(
  sourceRunId: string,
  deps: RerunDeps,
): Promise<RerunResult> {
  const source = await loadRunForRerun(sourceRunId)
  if (!source) {
    throw new RerunError('not_found', `rerun: run ${sourceRunId} not found`)
  }
  if (source.status === 'pending' || source.status === 'running') {
    throw new RerunError(
      'in_flight',
      `rerun: run ${sourceRunId} is ${source.status}; only terminal runs may be rerun`,
    )
  }

  const rerun = await createRerunRun({
    sourceRunId: source.id,
    identifier: `${source.identifier}#rerun`,
    pipelineId: source.pipelineId,
    input: source.input,
    pipelineVersionHash: source.pipelineVersionHash,
    parentRunId: source.parentRunId,
    workspaceId: source.workspaceId,
    createdByUserId: source.createdByUserId,
  })
  log.info('rerun created', { sourceRunId: source.id, rerunRunId: rerun.id })

  // Reuse the fan-out execution path verbatim: same markRunning → withSlot →
  // predict → complete/fail lifecycle. A rerun that fails again is recorded
  // `failed` (not thrown) so the caller can still compare the two outcomes.
  const child = await runChild(rerun.id, source.flowId, source.input, deps)

  return {
    runId: child.runId,
    sourceRunId: source.id,
    status: child.status,
    output: child.output,
    durationMs: child.durationMs,
  }
}

/** Re-exported so the HTTP layer / tests can name the source shape. */
export type { RerunSource }
