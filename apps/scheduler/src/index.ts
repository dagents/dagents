import { serve } from '@hono/node-server'
import { AppDataSource } from '@dagents/db'
import { createLogger, createRedis, startTracing } from '@dagents/shared'
import { buildApp } from './app.js'
import { createFlowisePredictionClient } from './prediction-client.js'
import { recoverStaleRuns } from './recovery.js'
import { createArtifactStoreFromEnv, createReproClient } from './repro-client.js'
import { createRedisSemaphore } from './semaphore.js'
import { startWorker } from './worker.js'

// Start OTel BEFORE DB/Redis init so the auto-instrumentations patch `fetch`
// (undici) before the worker's first prediction hop — W3C `traceparent` then
// propagates scheduler→gateway→flowise without per-call-site header plumbing
// (plan M6.1). The handle is awaited on shutdown to flush the
// BatchSpanProcessor so a SIGTERM doesn't drop the last in-flight batch.
const tracing = startTracing('scheduler')

/**
 * Scheduler entrypoint (M3.1 + M3.2 + M3.5 + M4.2 + M4.3).
 *
 * Two execution paths share one Redis concurrency gate (`dagents:sem`) and one
 * `runs` table:
 *
 * - **Queue worker (M3.1)** — `startWorker` BRPOPs `dagents:tasks` and runs each
 *   task through the Flowise Prediction API under the semaphore. Producers
 *   LPUSH `ScheduleTask` payloads; the worker acquires a slot *before* it
 *   dequeues, so a dequeued task always has a slot to run in (no orphaned
 *   work on crash). Graceful shutdown awaits in-flight runs.
 * - **HTTP fan-out (M3.2)** — `buildApp` exposes `POST /api/v1/scheduler/runs/
 *   fanout`, which creates a parent run + N child runs and gates each child's
 *   Prediction hop on the *same* semaphore.
 *
 * Both paths post through the gateway-facing prediction client (`x-run-id`
 * end-to-end) and record outcomes in `runs`. The semaphore is the single
 * concurrency budget across the process: a busy worker leaves fewer slots for
 * a fan-out request, and vice versa — which is the point (one upstream cost
 * ceiling).
 *
 * **Repro integration (M4.2)** — both paths also share one `ReproClient`
 * (`@dagents/repro`): every run is snapshotted + bound to a `pipeline_version_hash`
 * inline (atomic in `createRun`) and its output archived to MinIO
 * (`runs.artifact_uri`) on completion. Fan-out snapshots once per batch and
 * reuses the hash for parent + every child; rerun copies the source's hash
 * verbatim (no re-snapshot — comparability). Snapshot + archive are
 * best-effort: a Flowise/MinIO blip leaves a run unbound/unarchived (warned)
 * rather than failing it.
 *
 * **Reproduce (M4.3)** — `POST /api/v1/scheduler/runs/:runId/reproduce`
 * re-executes a terminal run with its same `pipeline_version_hash` + `input`,
 * structurally compares the new output to the original, and archives a JSON
 * report. It reuses the M4.2 artifact store for the report but is gated on
 * the run being bound (`pipeline_version_hash != null`) — a reproduce of an
 * unbound run is rejected with 422. Report archiving is best-effort: a MinIO
 * failure degrades to `artifactUri=null` rather than hiding the comparison.
 *
 * Bootstrap initializes the shared `AppDataSource` once (same pattern as
 * dispatch/gateway) so every request + worker iteration reuses the pool.
 *
 * **Restart recovery (M3.5)** — before the worker starts, `recoverStaleRuns`
 * zeroes the leaked `dagents:sem` counter and re-enqueues any run left in
 * `running` by a prior crash (BRPOP'd tasks are gone from `dagents:tasks`, so a
 * killed-mid-run row would otherwise hang forever). The worker then drains
 * the recovered queue like any other. Disable with `SCHEDULER_RECOVER_ON_START=0`
 * (e.g. a multi-instance deployment where one process must not zero another's
 * live slots — see `recovery.ts`'s single-instance note).
 *
 * Shutdown: SIGTERM/SIGINT → `worker.stop()` (awaits in-flight runs) → close
 * Redis → exit. The semaphore counter lives in Redis for the process lifetime;
 * a process killed mid-run leaks its held slot, which the next boot's
 * `recoverStaleRuns` re-seeds.
 */

const log = createLogger({ svc: 'scheduler' })

// Default matches the dagents docker-compose stack: Redis is remapped to
// 16479 on the host (see infra/.env.example). The dev compose stack runs redis
// with NO `--requirepass`, so the URL carries no password — mirroring how
// `@dagents/db` bakes its dev PG creds. A bare `redis://localhost:6379` would hit
// the wrong port (no redis on 6379 on this host). Override via REDIS_URL in any
// other environment.
const redisUrl =
  process.env.REDIS_URL ?? 'redis://localhost:16479'
const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080'
const maxConcurrent = Number(process.env.SCHEDULER_MAX_CONCURRENT ?? '10')
const port = Number(process.env.SCHEDULER_PORT ?? 8082)

async function bootstrap(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  log.info('scheduler db initialized', { initialized: AppDataSource.isInitialized })
}

await bootstrap()

// One Redis client + one semaphore, shared by the worker and the fan-out
// server. Sharing the client keeps a single connection pool; sharing the
// semaphore gives both paths one concurrency budget (`dagents:sem`).
const redis = createRedis(redisUrl)
const semaphore = createRedisSemaphore({ redis, maxConcurrent, semKey: 'sem' })

// Same prediction client shape for both paths: the worker posts one prediction
// per dequeued task; fan-out posts one per child. Both go through the gateway.
const prediction = createFlowisePredictionClient({
  gatewayUrl,
  authorization: process.env.GATEWAY_AUTH,
})

// Repro integration (M4.2): snapshot + bind + archive on every run. The store
// is built from MinIO env defaults (same dev-stack fallback as redis/gateway),
// and the repro client reuses the gateway URL to fetch flow JSON. Both paths
// (worker + fan-out/rerun) share this one client so a batch and a queued run
// resolve versions against the same `pipeline_versions` dedup table.
const repro = createReproClient({
  gatewayUrl,
  authorization: process.env.GATEWAY_AUTH,
  artifactStore: createArtifactStoreFromEnv(),
})

// Restart recovery (M3.5): clear any leaked semaphore slots and re-enqueue
// runs left `running` by a prior crash *before* the worker starts, so the
// recovered queue drains into a fresh concurrency budget. `recoverStaleRuns`
// is a no-op when there is nothing to recover (empty queue, zero counter).
// Default on; set SCHEDULER_RECOVER_ON_START=0 to skip (multi-instance).
const recoverOnStart = process.env.SCHEDULER_RECOVER_ON_START !== '0'
if (recoverOnStart) {
  await recoverStaleRuns({ redis, semaphore })
}

// Start the queue consumer. The worker holds no resources at construction (it
// acquires slots on demand), so starting it after recovery + before `serve()`
// is safe; if the queue is empty it parks on BRPOP and consumes nothing.
const worker = startWorker({ redis, semaphore, prediction, repro })

// Artifact store for the reproduce route (M4.3): archives the JSON comparison
// report as the re-run row's `artifact_uri`. Reuses the same store the M4.2
// `repro` client archives run outputs to (`createArtifactStoreFromEnv`) so a
// reproduce report lands in the same MinIO bucket as the runs it describes,
// rather than a second store. Constructed lazily inside `createS3ArtifactStore`,
// so building it here does not require MinIO to be up at boot — only when a
// reproduce actually PUTs. Best-effort: a missing endpoint leaves the store
// unset, and the reproduce route still computes + returns the comparison
// without archiving; a PUT failure degrades to `artifactUri=null` (warn).
const artifactStore = createArtifactStoreFromEnv()

const app = buildApp({
  prediction,
  semaphore,
  maxConcurrent,
  worker,
  repro,
  artifactStore,
})

function shutdown(): void {
  // Async shutdown — fire and forget; the process exits when it settles.
  void (async () => {
    try {
      await worker.stop()
      await redis.raw().quit()
      await tracing.shutdown()
    } catch (err) {
      log.error('shutdown error', { error: String(err) })
    }
    process.exit(0)
  })()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

serve({ fetch: app.fetch, port })
log.info('scheduler on :%d (maxConcurrent=%d)', { port, maxConcurrent })
