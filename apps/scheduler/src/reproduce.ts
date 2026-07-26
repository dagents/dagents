import { createLogger } from '@dagents/shared'
import {
  archiveArtifact,
  compareOutputs,
  type ArtifactStore,
  type RunArtifact,
} from '@dagents/repro'
import { runChild, type FanOutDeps } from './fanout.js'
import {
  createRerunRun,
  loadRunForReproduce,
  type ReproduceSource,
} from './runs-repo.js'

/**
 * Reproduce a run end-to-end (plan M4.3 / P1.8.T5).
 *
 * The repro contract (architecture v0.2 §4.4 / spec §1.8.T5) is "同一
 * pipeline_version_hash + 同一 input → 可重跑 + 可追溯 + 可比对" — re-runnable,
 * traceable, comparable, **not** byte-identical (LLMs are non-deterministic).
 * This function delivers all three by composing the existing primitives:
 *
 *   - **可重跑 (re-runnable):** re-executes the source run with its *same*
 *     `input` + `pipeline_version_hash` + flow id, through the exact same
 *     `runChild` lifecycle a fan-out child / rerun uses, into a fresh `runs`
 *     row. The source row is left untouched.
 *   - **可追溯 (traceable):** the fresh row carries `created_by_run_id` =
 *     source id (provenance) and copies the source's hash + input + parent, so
 *     the two are comparable-by-identity (same fields as the rerun path).
 *   - **可比对 (comparable):** the new output is structurally compared
 *     (`compareOutputs`, canonical key-sorted JSON) to the source's recorded
 *     `output` — so a re-run that differs only by object key order still
 *     matches (non-byte-level, as the issue's acceptance requires).
 *
 * It also archives a **reproduce report** ({ source, rerun, match, diff })
 * as the rerun row's artifact and writes the URI back into
 * `runs.artifact_uri`, so the comparison verdict is persisted alongside the
 * run it describes ("复现报告生成, 结果可比对" — issue acceptance).
 *
 * Why this lives here, not in `@dagents/repro`: `reproduce()` in the repro package
 * is a pure compare given an injected executor — it deliberately depends on no
 * scheduler type so the library stays decoupled. This module is the scheduler
 * integration that supplies the real executor (`runChild`) + DB load/create +
 * artifact archive, i.e. the runtime wiring M4.2's design reserved for the
 * scheduler.
 *
 * Failure semantics mirror `rerunRun`: a Prediction failure is NOT thrown —
 * the re-run is recorded `failed`, the report is archived with the failure as
 * the "new output", and `status: 'failed'` is returned so the caller can still
 * compare the two outcomes. Only `ReproError` (domain guard) or an
 * infrastructure failure (DB write) throws.
 */

const log = createLogger({ svc: 'scheduler:reproduce' })

/**
 * Raised when a reproduce cannot proceed for a domain reason. The HTTP layer
 * maps `code` to a status: `not_found` → 404, `in_flight` → 409, everything
 * else → 422 (precondition). Mirrors `RerunError`'s convention.
 */
export type ReproErrorCode =
  | 'not_found'
  | 'in_flight'
  | 'not_completed'
  | 'unbound'

export class ReproError extends Error {
  constructor(
    public code: ReproErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ReproError'
  }
}

export interface ReproduceDeps extends FanOutDeps {
  /**
   * Artifact store for archiving the reproduce report (injected so tests use an
   * in-memory stub; production wires `createS3ArtifactStore`). Optional: when
   * omitted the report is still computed and returned, just not archived — the
   * comparison verdict is the primary acceptance, persistence is secondary.
   */
  artifactStore?: ArtifactStore
}

export interface ReproduceReport {
  /** The run being reproduced. */
  sourceRunId: string
  /** The fresh run the reproduce executed (the re-run). */
  rerunRunId: string
  /** `completed` (predict succeeded) or `failed` (predict threw). */
  status: 'completed' | 'failed'
  /** Whether the re-run's output matched the source's structurally. */
  match: boolean
  /** Structural diff path when not equal; null when equal. */
  diff: string | null
  /** The pipeline_version_hash both runs share (the comparable identity). */
  versionHash: string
  /** The output the re-run produced. */
  output: unknown
  /** The source's baseline output the re-run was compared to. */
  expected: unknown
  /** S3 URI of the archived report, when `artifactStore` was supplied. */
  artifactUri: string | null
  durationMs: number
}

/**
 * Reproduce a terminal run: re-execute it with the same hash + input + flow,
 * structurally compare the new output to the original, and archive a report.
 *
 * Guards (domain → `ReproError`, mapped to HTTP status by the caller):
 *   - source missing → `not_found` (404)
 *   - source not terminal (`pending`/`running`) → `in_flight` (409)
 *   - source not `completed` → `not_completed` (422) — a failed run has no
 *     baseline output to compare against
 *   - source has no `pipeline_version_hash` → `unbound` (422)
 *
 * Never throws on a Prediction failure: the re-run is stamped `failed`, the
 * report's `output`/`diff` describe that failure, and `status: 'failed'` is
 * returned (same "comparable even when it fails again" shape as `rerunRun`).
 */
export async function reproduceRun(
  sourceRunId: string,
  deps: ReproduceDeps,
): Promise<ReproduceReport> {
  const source = await loadRunForReproduce(sourceRunId)
  if (!source) {
    throw new ReproError('not_found', `reproduce: run ${sourceRunId} not found`)
  }
  if (source.status === 'pending' || source.status === 'running') {
    throw new ReproError(
      'in_flight',
      `reproduce: run ${sourceRunId} is ${source.status}; only terminal runs may be reproduced`,
    )
  }
  // A failed/cancelled source has no meaningful baseline output to compare
  // against — `output` would be `{ error }` / null. Reproduce is about
  // "same input → comparable output", which presupposes a completed baseline.
  if (source.status !== 'completed') {
    throw new ReproError(
      'not_completed',
      `reproduce: run ${sourceRunId} is ${source.status}; only completed runs have a baseline to compare`,
    )
  }
  if (!source.pipelineVersionHash) {
    throw new ReproError(
      'unbound',
      `reproduce: run ${sourceRunId} has no pipeline_version_hash; bind it to a snapshot first`,
    )
  }

  // Re-execute into a fresh row that copies the source's comparable identity
  // (hash + input + parent) — same shape as a rerun, so the two are
  // comparable-by-identity. `created_by_run_id` = source for provenance.
  const rerun = await createRerunRun({
    sourceRunId: source.id,
    identifier: `${source.identifier}#repro`,
    pipelineId: source.pipelineId,
    input: source.input,
    pipelineVersionHash: source.pipelineVersionHash,
    parentRunId: source.parentRunId,
    workspaceId: source.workspaceId,
    createdByUserId: source.createdByUserId,
  })
  log.info('reproduce re-run created', {
    sourceRunId: source.id,
    rerunRunId: rerun.id,
    versionHash: source.pipelineVersionHash,
  })

  // Reuse the fan-out / rerun execution path verbatim: markRunning →
  // semaphore.withSlot → predict → complete/fail. A re-run that fails is
  // recorded `failed` (not thrown) so we still compare + report it.
  const child = await runChild(rerun.id, source.flowId, source.input, deps)

  // Structural comparison (canonical, non-byte-level): a re-run that differs
  // only by object key order still matches. When the re-run failed, its output
  // is `{ error }` — compare anyway so the report shows *how* it diverged.
  const cmp = compareOutputs(source.output, child.output)

  // Archive the reproduce report as the re-run's artifact, if a store was
  // supplied. Best-effort: the comparison verdict is the primary acceptance, so
  // an archive failure (MinIO unreachable / credentials / bucket missing) must
  // NOT hide an already-computed match/diff — degrade to `artifactUri=null` +
  // a warn log, keeping the 200 response. This mirrors the "store omitted →
  // still return the comparison" downgrade: persistence is secondary to the
  // verdict whether the store is absent *or* failing. The PUT still happens
  // before any URI write (inside `archiveArtifact`), so a failed PUT never
  // leaves a dangling URI on the row.
  let artifactUri: string | null = null
  if (deps.artifactStore) {
    const reportBlob = buildReportArtifact({
      sourceRunId: source.id,
      rerunRunId: rerun.id,
      status: child.status,
      match: cmp.equal,
      diff: cmp.diff,
      versionHash: source.pipelineVersionHash,
      output: child.output,
      expected: source.output,
      artifactUri: source.artifactUri,
      durationMs: child.durationMs,
    })
    try {
      const archived = await archiveArtifact(rerun.id, reportBlob, deps.artifactStore)
      artifactUri = archived.uri
    } catch (err) {
      // Archive failed after the re-run row + comparison already succeeded.
      // Degrade rather than 502: the caller still gets match/diff/status, just
      // no persisted report URI (the row's `artifact_uri` stays null).
      log.warn('reproduce report archive failed; returning verdict without artifact', {
        sourceRunId: source.id,
        rerunRunId: rerun.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.info('reproduce complete', {
    sourceRunId: source.id,
    rerunRunId: rerun.id,
    match: cmp.equal,
    status: child.status,
  })

  return {
    sourceRunId: source.id,
    rerunRunId: rerun.id,
    status: child.status,
    match: cmp.equal,
    diff: cmp.diff,
    versionHash: source.pipelineVersionHash,
    output: child.output,
    expected: source.output,
    artifactUri,
    durationMs: child.durationMs,
  }
}

/** Shape of the archived reproduce report (JSON; contentType application/json). */
export interface ArchivedReproduceReport {
  sourceRunId: string
  rerunRunId: string
  status: 'completed' | 'failed'
  match: boolean
  diff: string | null
  versionHash: string
  output: unknown
  expected: unknown
  /** The source run's own archived artifact URI, for cross-reference. */
  sourceArtifactUri: string | null
  durationMs: number
  /** Schema version so a reader can evolve the shape safely. */
  schema: 'mil.repro.report/v1'
}

/**
 * Build the JSON report blob archived as the re-run's artifact. Kept separate
 * from `reproduceRun` so the shape is explicit + testable, and so a future
 * reader (`store.get(uri)`) knows the exact contract.
 */
function buildReportArtifact(report: {
  sourceRunId: string
  rerunRunId: string
  status: 'completed' | 'failed'
  match: boolean
  diff: string | null
  versionHash: string
  output: unknown
  expected: unknown
  artifactUri: string | null
  durationMs: number
}): RunArtifact {
  const body: ArchivedReproduceReport = {
    sourceRunId: report.sourceRunId,
    rerunRunId: report.rerunRunId,
    status: report.status,
    match: report.match,
    diff: report.diff,
    versionHash: report.versionHash,
    output: report.output,
    expected: report.expected,
    sourceArtifactUri: report.artifactUri,
    durationMs: report.durationMs,
    schema: 'mil.repro.report/v1',
  }
  return {
    bytes: Buffer.from(JSON.stringify(body), 'utf8'),
    contentType: 'application/json',
    filename: 'reproduce-report.json',
  }
}

/** Re-exported so the HTTP layer / tests can name the source shape. */
export type { ReproduceSource }
