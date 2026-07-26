import { runQuery } from '@dagents/db'
import { sha256Hex } from './hash.js'
import { fetchFlowJson, type FetchFlowOpts } from './flow.js'
import type { ArtifactStore, RunArtifact } from './artifact-store.js'

/**
 * Repro core: flow snapshot + version binding + artifact archive + reproduce
 * (plan M4.1 / spec §1.8, architecture v0.2 §5.3).
 *
 * The four operations the issue acceptance names:
 *
 *   - `snapshotPipeline(flowId)` — fetch the flow JSON, SHA-256 it, dedup-write
 *     into `pipeline_versions` (UNIQUE on `version_hash` → a re-snapshot of an
 *     unchanged flow reuses the existing row).
 *   - `bindRunToVersion(runId, hash)` — stamp `runs.pipeline_version_hash`.
 *   - `archiveArtifact(runId, artifact)` — PUT to MinIO, write `runs.artifact_uri`.
 *   - `reproduce(...)` — re-run with the same hash + input and structurally
 *     compare the outputs.
 *
 * All DB access goes through `runQuery` parameterised raw SQL — same
 * decorator-free-reads rationale as `runs-repo.ts`: the `PipelineVersion` entity
 * exists for schema + typing, not runtime queries. The flow fetcher and artifact
 * store are injected so tests can stub them without a live Flowise / MinIO.
 */

export { fetchFlowJson } from './flow.js'
export type { FetchFlowOpts, FetchedFlow, FlowFetchError } from './flow.js'
export { createS3ArtifactStore, parseS3Uri, s3Uri } from './artifact-store.js'
export type {
  ArtifactStore,
  RunArtifact,
  PutResult,
  S3ArtifactStoreOpts,
} from './artifact-store.js'
export { canonicalize, stableStringify, sha256Hex, sha256Bytes } from './hash.js'

export interface PipelineVersion {
  id: string
  pipelineId: string
  versionHash: string
  flowJson: unknown
  note: string | null
  createdAt: Date
}

export interface SnapshotOpts extends FetchFlowOpts {
  /** Optional version note stored on the snapshot row. */
  note?: string
  /** Optional creator (user id) for `created_by_user_id`. */
  createdByUserId?: string | null
}

export interface SnapshotDeps {
  /** Fetch the flow JSON (injected so tests can stub without Flowise). */
  fetchFlow: typeof fetchFlowJson
}

/**
 * Snapshot a flow: fetch its JSON, hash it (SHA-256 of the canonical
 * serialization), and dedup-write into `pipeline_versions`. Because
 * `version_hash` is UNIQUE, a second snapshot of the same flow content reuses
 * the existing row and returns it — "同 flow 二次快照复用 hash" (issue acceptance).
 *
 * Uses `ON CONFLICT (version_hash) DO NOTHING` + a follow-up SELECT so the
 * insert is idempotent under concurrency: two snapshots racing on the same
 * flow both resolve to the same row, and neither sees a UNIQUE violation.
 */
export async function snapshotPipeline(
  flowId: string,
  opts: SnapshotOpts,
  deps: SnapshotDeps = { fetchFlow: fetchFlowJson },
): Promise<PipelineVersion> {
  const { flowJson } = await deps.fetchFlow(flowId, opts)
  const versionHash = sha256Hex(flowJson)

  // ON CONFLICT (version_hash) DO NOTHING: a re-snapshot of unchanged content
  // is a no-op insert. RETURNING yields the row on first insert; on conflict
  // we SELECT the existing row so the caller always gets the canonical row.
  const { records } = await runQuery<{ id: string; created_at: Date }>(
    `INSERT INTO pipeline_versions (pipeline_id, version_hash, flow_json, note, created_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (version_hash) DO NOTHING
     RETURNING id, created_at`,
    [
      flowId,
      versionHash,
      JSON.stringify(flowJson),
      opts.note ?? null,
      opts.createdByUserId ?? null,
    ],
  )
  if (records[0]) {
    return {
      id: records[0].id,
      pipelineId: flowId,
      versionHash,
      flowJson,
      note: opts.note ?? null,
      createdAt: records[0].created_at,
    }
  }

  // Conflict — the row already exists. Fetch it so the caller still gets the
  // canonical id + createdAt (a re-snapshot must not clobber the original).
  const { records: existing } = await runQuery<{
    id: string
    flow_json: unknown
    note: string | null
    created_at: Date
  }>(
    `SELECT id, flow_json, note, created_at
       FROM pipeline_versions
      WHERE version_hash = $1`,
    [versionHash],
  )
  const row = existing[0]
  if (!row) throw new Error('snapshotPipeline: INSERT conflicted but row not found')
  return {
    id: row.id,
    pipelineId: flowId,
    versionHash,
    flowJson: row.flow_json,
    note: row.note,
    createdAt: row.created_at,
  }
}

/**
 * Bind a run to a pipeline version by stamping `runs.pipeline_version_hash`.
 * Idempotent: re-binding to the same hash is a no-op; the `WHERE id = $1` guard
 * means a missing run updates zero rows (caller checks the returned count).
 * Returns true if a row was updated, false if the run id didn't exist.
 */
export async function bindRunToVersion(
  runId: string,
  versionHash: string,
): Promise<boolean> {
  const { affected } = await runQuery(
    `UPDATE runs SET pipeline_version_hash = $2 WHERE id = $1`,
    [runId, versionHash],
  )
  return (affected ?? 0) > 0
}

export interface ArchiveResult {
  /** The S3 URI the artifact was stored under. */
  uri: string
  /** SHA-256 of the artifact bytes (content address). */
  sha256: string
}

/**
 * Archive a run's artifact to object storage and write the URI back into
 * `runs.artifact_uri`. The store is injected so tests can use an in-memory
 * stub. Returns the URI + sha. "artifact 可存可取" (issue acceptance): a later
 * `store.get(uri)` retrieves the same bytes.
 *
 * The `runs.artifact_uri` write is separate from the PUT so a failed PUT never
 * leaves a dangling URI on the run row — if the PUT throws, the row is
 * untouched.
 */
export async function archiveArtifact(
  runId: string,
  artifact: RunArtifact,
  store: ArtifactStore,
): Promise<ArchiveResult> {
  const put = await store.put(runId, artifact)
  await runQuery(`UPDATE runs SET artifact_uri = $2 WHERE id = $1`, [
    runId,
    put.uri,
  ])
  return { uri: put.uri, sha256: put.sha256 }
}

/** A structural comparison verdict (reproduce, P1.8.T5). */
export interface CompareResult {
  /** True when the two outputs match structurally. */
  equal: boolean
  /** Human-readable diff path when not equal; null when equal. */
  diff: string | null
}

/**
 * Structural comparison of two outputs (P1.8.T5 "结构比对, 非字节级"). Two
 * outputs are equal when their canonical (key-sorted) JSON serializations
 * match — so a re-run whose output differs only by object key order still
 * compares equal (the repro contract is *structural*, not byte-for-byte).
 *
 * Returns `{ equal, diff }` so a caller can report *where* the structures
 * diverged. Deep equality walks objects/arrays recursively; the first
 * divergence short-circuits and is described in `diff`.
 */
export function compareOutputs(a: unknown, b: unknown): CompareResult {
  const diff = deepDiff(a, b, '$')
  return diff === null ? { equal: true, diff: null } : { equal: false, diff }
}

/** Recursive structural diff; returns null when equal, a path string when not. */
function deepDiff(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null
  if (typeof a !== typeof b) return `${path}: type ${typeof a} !== ${typeof b}`
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return `${path}: array !== non-array`
    if (a.length !== b.length) return `${path}: array length ${a.length} !== ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = deepDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (a !== null && typeof a === 'object') {
    if (b === null || typeof b !== 'object') return `${path}: object !== ${b === null ? 'null' : 'non-object'}`
    const ka = Object.keys(a as Record<string, unknown>).sort()
    const kb = Object.keys(b as Record<string, unknown>).sort()
    // key set differs → structural mismatch
    if (ka.join('') !== kb.join('')) {
      return `${path}: object keys differ`
    }
    for (const k of ka) {
      const d = deepDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      )
      if (d) return d
    }
    return null
  }
  // primitive mismatch (number, string, boolean, null, undefined, bigint)
  return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`
}

/**
 * The executor a reproduce run uses to produce output. Injected so the repro
 * package doesn't depend on the scheduler — the scheduler supplies its real
 * `PredictionClient`-backed executor at integration time (M4.2), and tests
 * supply a deterministic stub.
 */
export type ReproduceExecutor = (input: {
  flowId: string
  input: unknown
  versionHash: string
}) => Promise<unknown>

export interface ReproduceResult {
  /** Whether the two outputs matched structurally. */
  match: boolean
  /** The structural diff when not equal; null when equal. */
  diff: string | null
  /** The output the reproduce run produced. */
  output: unknown
  /** The original output being compared against. */
  expected: unknown
}

export interface ReproduceOpts {
  flowId: string
  input: unknown
  versionHash: string
  /** The original run's output — the baseline to compare against. */
  expectedOutput: unknown
  /** Executes the reproduce prediction (injected). */
  execute: ReproduceExecutor
}

/**
 * Reproduce a run: re-execute against the same `versionHash` + `input` and
 * structurally compare the new output to the original. "同 hash + 同 input 重跑
 * + 结构比对" (issue acceptance). Does NOT touch the DB — it's a pure compare
 * given an executor, so it composes with whatever run-creation path the caller
 * uses (scheduler M4.2 wires the real executor; tests use a stub).
 */
export async function reproduce(opts: ReproduceOpts): Promise<ReproduceResult> {
  const output = await opts.execute({
    flowId: opts.flowId,
    input: opts.input,
    versionHash: opts.versionHash,
  })
  const cmp = compareOutputs(opts.expectedOutput, output)
  return {
    match: cmp.equal,
    diff: cmp.diff,
    output,
    expected: opts.expectedOutput,
  }
}
