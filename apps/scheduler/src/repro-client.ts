import { createLogger, type Logger } from '@dagents/shared'
import {
  snapshotPipeline as snapshotFlowVersion,
  archiveArtifact as archiveRunArtifact,
  createS3ArtifactStore,
  type ArtifactStore,
  type RunArtifact,
  type S3ArtifactStoreOpts,
} from '@dagents/repro'
import { recordVersionLockAudit } from './audit.js'

/**
 * Scheduler → `@dagents/repro` adapter (plan M4.2 / spec §1.8).
 *
 * `@dagents/repro` exposes the four repro primitives — `snapshotPipeline`,
 * `bindRunToVersion`, `archiveArtifact`, `reproduce` — as standalone functions
 * that take their dependencies (flow fetcher, artifact store) as arguments.
 * The scheduler only needs two of them wired into its run lifecycle, and it
 * wants them as an injected interface (so tests swap in a stub the same way they
 * stub `PredictionClient`) rather than a bag of functions. This module is that
 * interface + the production factory.
 *
 * ## Best-effort contract
 *
 * Both operations are best-effort by design (confirmed M4.2 review, 03:37): a
 * Flowise flow-fetch or MinIO PUT failure must NOT block or fail a run — the run
 * still executes and records its outcome. A failed snapshot leaves the run
 * unbound (`pipeline_version_hash = null`); a failed archive leaves
 * `artifact_uri = null`. Each failure emits a `warn` log so an operator can see
 * how many runs landed unbound/unarchived — "未绑定 run" stays observable without
 * being a hard error. This matches the existing `failRun(...).catch(() =>
 * undefined)` tolerance in `worker.ts`.
 *
 * ## Binding is inline, not via `bindRunToVersion`
 *
 * The scheduler binds a run to its version by passing `pipelineVersionHash`
 * into `createRun` (atomic — one INSERT writes the row + its hash together).
 * `repro.bindRunToVersion` is therefore NOT called from the scheduler paths; it
 * exists for externally-created runs. So `snapshotPipeline` here returns only
 * the hash the caller threads into `createRun`.
 */

/**
 * The repro surface the scheduler consumes. Both methods resolve to `null` on
 * failure (best-effort) rather than rejecting — see the module doc.
 */
export interface ReproClient {
  /**
   * Snapshot a flow: fetch its JSON, SHA-256 it, dedup-write into
   * `pipeline_versions`. Returns the version hash the caller threads into
   * `createRun({ pipelineVersionHash })`, or `null` if the snapshot failed
   * (the run is then created unbound).
   *
   * M6.6: a successful snapshot also writes a `pipeline_version.lock` audit
   * row (the version-lock is a sensitive op per spec §1.4 职责 #5 / risk R15).
   * The audit is fire-and-forget and best-effort, mirroring the snapshot
   * itself — a failed audit write never re-fails the snapshot.
   */
  snapshotPipeline(flowId: string, runId?: string | null, workspaceId?: string | null): Promise<string | null>
  /**
   * Archive a run's output to object storage and write `runs.artifact_uri`.
   * Returns the artifact URI, or `null` if archiving failed (the row's
   * `artifact_uri` is left null).
   */
  archiveArtifact(runId: string, output: unknown): Promise<string | null>
}

export interface ReproClientOpts {
  /** Gateway base URL used to fetch the flow JSON (same gateway as prediction). */
  gatewayUrl: string
  /** Optional Authorization header forwarded to the gateway. */
  authorization?: string
  /** Object store for artifacts (MinIO/S3). Injected so tests can stub. */
  artifactStore: ArtifactStore
  logger?: Logger
}

/**
 * Production repro client: real flow fetch (through the gateway) + the injected
 * artifact store. The store is created lazily by `@dagents/repro`'s
 * `createS3ArtifactStore`, so constructing this client does not require MinIO to
 * be up — mirroring how `createFlowisePredictionClient` defers its first fetch.
 */
export function createReproClient(opts: ReproClientOpts): ReproClient {
  const log = opts.logger ?? createLogger({ svc: 'scheduler:repro' })
  return {
    snapshotPipeline: async (flowId, runId = null, workspaceId = null) => {
      try {
        const snap = await snapshotFlowVersion(flowId, {
          gatewayUrl: opts.gatewayUrl,
          authorization: opts.authorization,
        })
        // M6.6: audit the version lock. Best-effort — a failed audit write is
        // swallowed inside recordVersionLockAudit and never re-fails the
        // snapshot (which already succeeded). The run id + hash tie the audit
        // row to the run + trace that performed the lock.
        void recordVersionLockAudit({
          pipelineId: flowId,
          versionHash: snap.versionHash,
          runId,
          workspaceId,
        })
        return snap.versionHash
      } catch (err) {
        // Flowise unreachable / gateway 4xx / DB write failed. Best-effort: the
        // caller creates the run unbound (hash=null) and continues. A warn (not
        // error) keeps the run green while making the gap observable.
        log.warn('snapshot failed; run will be created unbound', {
          flowId,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
    archiveArtifact: async (runId, output) => {
      try {
        const artifact = outputToArtifact(output)
        const res = await archiveRunArtifact(runId, artifact, opts.artifactStore)
        return res.uri
      } catch (err) {
        // MinIO unreachable / bucket missing. Best-effort: `runs.artifact_uri`
        // stays null; the run's outcome is already recorded. Warn so the gap is
        // visible without failing the run.
        log.warn('archive failed; artifact_uri left null', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
  }
}

/**
 * Build the production artifact store from MinIO/S3 env. Mirrors the env-default
 * pattern of `index.ts`'s redis/gateway URLs: the dev docker-compose creds are
 * the fallback so `pnpm dev` works without a local `.env`.
 */
export function createArtifactStoreFromEnv(): ArtifactStore {
  return createS3ArtifactStore({
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'dagents',
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'dagents_dev',
    bucket: process.env.MINIO_BUCKET ?? 'dagents',
  } satisfies S3ArtifactStoreOpts)
}

/**
 * Serialize a run's `output` (opaque JSON) into an artifact. The output is
 * JSON — stored as UTF-8 bytes with `application/json` so a reader can parse it
 * back. `filename` is a human hint folded into the object key (the SHA is the
 * content address; the filename is not used for addressing).
 */
function outputToArtifact(output: unknown): RunArtifact {
  return {
    bytes: Buffer.from(JSON.stringify(output ?? null)),
    contentType: 'application/json',
    filename: 'output.json',
  }
}
