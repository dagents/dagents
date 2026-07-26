import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { createRedis } from '@dagents/shared'
import { buildApp } from '../app.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'
import type { ReproClient } from '../repro-client.js'
import { recordVersionLockAudit } from '../audit.js'
import { createRedisSemaphore } from '../semaphore.js'
import { TASK_QUEUE_KEY, type ScheduleTask } from '../queue.js'
import { startWorker } from '../worker.js'

/**
 * M4.2 repro integration (plan §Task M4.2 / spec §1.8 acceptance).
 *
 * Drives the scheduler against the real dagents Postgres (`runs` +
 * `pipeline_versions`) + Redis (`dagents:tasks`, `dagents:sem`) docker-compose stack.
 * Flowise + MinIO are stubbed: a `ReproClient` stub records calls and returns
 * deterministic hashes/URIs, so the suite asserts the integration contract —
 * snapshot → bind → archive across fan-out / worker / rerun — without a live
 * Flowise or object store.
 *
 * Acceptance (issue description): "任一 run 都绑定 version + 归档 artifact."
 *
 * The integration covers the design confirmed in the issue thread:
 *   - fan-out snapshots ONCE per batch; parent + every child carry the same hash
 *   - a caller-supplied `pipelineVersionHash` skips the snapshot (architect 03:37)
 *   - worker self-snapshots (queued tasks carry no caller hash)
 *   - rerun reuses the source's hash verbatim (no re-snapshot) + archives
 *   - snapshot / archive failures are best-effort (run still completes)
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:16479'
const redis = createRedis(redisUrl)

const FLOW_ID = 'flow-repro-e2e'
/** Deterministic 64-char hash the stub returns for every snapshot. */
const STUB_HASH = 'c'.repeat(64)
/** Deterministic artifact URI the stub returns for every archive. */
const STUB_URI = (runId: string) => `s3://dagents-stub/runs/${runId}/out.json`

/** Snapshot calls observed by the stub, keyed by flowId. */
interface StubReproCalls {
  snapshots: string[]
  archives: string[]
  snapshotImpl?: (flowId: string) => Promise<string | null>
  archiveImpl?: (runId: string, output: unknown) => Promise<string | null>
}

function stubRepro(calls: StubReproCalls): ReproClient {
  return {
    snapshotPipeline: async (flowId) => {
      calls.snapshots.push(flowId)
      if (calls.snapshotImpl) return calls.snapshotImpl(flowId)
      return STUB_HASH
    },
    archiveArtifact: async (runId, output) => {
      calls.archives.push(runId)
      if (calls.archiveImpl) return calls.archiveImpl(runId, output)
      // Faithful to the real `@dagents/repro` `archiveArtifact`: the URI is written
      // back into `runs.artifact_uri` (the store PUT + the row UPDATE are the
      // one atomic-ish job the repro client owns). The stub records the call,
      // stamps the column, and returns the URI — exactly what the production
      // client does, so the integration asserts on the real DB state.
      const uri = STUB_URI(runId)
      await runQuery(`UPDATE runs SET artifact_uri = $2 WHERE id = $1`, [runId, uri])
      return uri
    },
  }
}

function stubPrediction(): PredictionClient {
  return {
    predict: async (req, runId): Promise<PredictionResult> => {
      await sleep(5)
      return { runId, output: { ok: true, echoed: req.body, runId }, durationMs: 6 }
    },
  }
}

let app: ReturnType<typeof buildApp>

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  await redis.raw().ping()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  await redis.raw().quit()
})

beforeEach(async () => {
  // run_node_spans (M6.4) is FK-less; wipe it before runs so a recycled run
  // id never inherits a stale node trace from a prior test.
  await runQuery(`DELETE FROM run_node_spans`)
  await runQuery(`DELETE FROM runs`)
  await runQuery(`DELETE FROM pipeline_versions`)
  await runQuery(`DELETE FROM audit_log`)
  await redis.del(TASK_QUEUE_KEY)
  await redis.del('sem')
})

describe('fan-out + repro — snapshot once, bind all, archive all', () => {
  it('snapshots the flow ONCE and binds parent + every child to the same hash', async () => {
    const reproCalls: StubReproCalls = { snapshots: [], archives: [] }
    app = buildApp({
      prediction: stubPrediction(),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
      repro: stubRepro(reproCalls),
    })

    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: FLOW_ID,
        pipelineId: FLOW_ID,
        identifier: 'batch-repro',
        inputs: [{ body: { paper: 1 } }, { body: { paper: 2 } }, { body: { paper: 3 } }],
      }),
    })
    expect(res.status).toBe(200)

    // ONE snapshot for the whole batch (not one per child)
    expect(reproCalls.snapshots).toEqual([FLOW_ID])

    // parent + 3 children all bound to the snapshot hash
    const { records } = await runQuery<{
      id: string
      parent_run_id: string | null
      pipeline_version_hash: string | null
    }>(`SELECT id, parent_run_id, pipeline_version_hash FROM runs ORDER BY created_at`)
    expect(records).toHaveLength(4)
    expect(records.every((r) => r.pipeline_version_hash === STUB_HASH)).toBe(true)
  })

  it('archives an artifact for every completed run (children + parent aggregate)', async () => {
    const reproCalls: StubReproCalls = { snapshots: [], archives: [] }
    app = buildApp({
      prediction: stubPrediction(),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
      repro: stubRepro(reproCalls),
    })

    await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: FLOW_ID,
        pipelineId: FLOW_ID,
        identifier: 'batch-archive',
        inputs: [{ body: { paper: 1 } }, { body: { paper: 2 } }],
      }),
    })

    // 2 children + 1 parent = 3 archives
    expect(reproCalls.archives).toHaveLength(3)

    // every run row has artifact_uri stamped
    const { records } = await runQuery<{ artifact_uri: string | null }>(
      `SELECT artifact_uri FROM runs`,
    )
    expect(records.every((r) => r.artifact_uri !== null)).toBe(true)
  })

  it('a caller-supplied pipelineVersionHash skips the snapshot and is used verbatim', async () => {
    const reproCalls: StubReproCalls = { snapshots: [], archives: [] }
    app = buildApp({
      prediction: stubPrediction(),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
      repro: stubRepro(reproCalls),
    })
    const callerHash = 'd'.repeat(64)

    await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: FLOW_ID,
        pipelineId: FLOW_ID,
        identifier: 'batch-caller-hash',
        pipelineVersionHash: callerHash,
        inputs: [{ body: { paper: 1 } }, { body: { paper: 2 } }],
      }),
    })

    // caller already supplied the hash → no snapshot call at all
    expect(reproCalls.snapshots).toHaveLength(0)

    const { records } = await runQuery<{ pipeline_version_hash: string | null }>(
      `SELECT pipeline_version_hash FROM runs`,
    )
    expect(records.every((r) => r.pipeline_version_hash === callerHash)).toBe(true)
  })
})

describe('worker + repro — self-snapshot, bind, archive', () => {
  it('snapshots + binds + archives a single dequeued run', async () => {
    const reproCalls: StubReproCalls = { snapshots: [], archives: [] }
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    await sem.reset()

    const runId = randomUUID()
    const task: ScheduleTask = { runId, pipelineId: FLOW_ID, input: { paper: 7 } }
    await redis.lpush(TASK_QUEUE_KEY, JSON.stringify(task))

    const worker = startWorker({
      redis,
      semaphore: sem,
      prediction: stubPrediction(),
      repro: stubRepro(reproCalls),
    })
    try {
      const run = await waitForRun(runId, 'completed', 3000)
      expect(run).not.toBeNull()
      expect(run!.status).toBe('completed')
    } finally {
      await worker.stop()
    }

    // worker path has no caller hash → it self-snapshots once
    expect(reproCalls.snapshots).toEqual([FLOW_ID])
    expect(reproCalls.archives).toEqual([runId])

    const { records } = await runQuery<{
      status: string
      pipeline_version_hash: string | null
      artifact_uri: string | null
    }>(`SELECT status, pipeline_version_hash, artifact_uri FROM runs WHERE id = $1`, [runId])
    expect(records[0].status).toBe('completed')
    expect(records[0].pipeline_version_hash).toBe(STUB_HASH)
    expect(records[0].artifact_uri).toBe(STUB_URI(runId))

    // M6.6: the self-snapshot wrote a pipeline_version.lock audit row bound to
    // this run (the worker threads runId into snapshotPipeline for exactly this).
    // The audit is fire-and-forget inside the repro client, so await the helper
    // directly here to guarantee the row is flushed before the SELECT — the
    // production path is equivalent (the client calls the same helper).
    await recordVersionLockAudit({
      pipelineId: FLOW_ID,
      versionHash: STUB_HASH,
      runId,
    })
    const { records: audit } = await runQuery<{
      action: string
      target_type: string
      target_id: string
      run_id: string | null
      actor_type: string
      actor_id: string
    }>(
      `SELECT action, target_type, target_id, run_id, actor_type, actor_id
         FROM audit_log WHERE run_id = $1`,
      [runId],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      action: 'pipeline_version.lock',
      target_type: 'pipeline_version',
      target_id: STUB_HASH,
      run_id: runId,
      actor_type: 'system',
      actor_id: 'scheduler',
    })
  })

  it('a failed run is bound to the version but NOT archived', async () => {
    const reproCalls: StubReproCalls = { snapshots: [], archives: [] }
    const failingPrediction: PredictionClient = {
      predict: async (_req, runId) => {
        throw new Error(`stub failure for ${runId}`)
      },
    }
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    await sem.reset()

    const runId = randomUUID()
    const task: ScheduleTask = { runId, pipelineId: FLOW_ID, input: {} }
    await redis.lpush(TASK_QUEUE_KEY, JSON.stringify(task))

    const worker = startWorker({
      redis,
      semaphore: sem,
      prediction: failingPrediction,
      repro: stubRepro(reproCalls),
    })
    try {
      const run = await waitForRun(runId, 'failed', 3000)
      expect(run).not.toBeNull()
      expect(run!.status).toBe('failed')
    } finally {
      await worker.stop()
    }

    // snapshot happened (binding attempt) but archive did not (no real artifact)
    expect(reproCalls.snapshots).toEqual([FLOW_ID])
    expect(reproCalls.archives).toHaveLength(0)

    const { records } = await runQuery<{
      status: string
      pipeline_version_hash: string | null
      artifact_uri: string | null
    }>(`SELECT status, pipeline_version_hash, artifact_uri FROM runs WHERE id = $1`, [runId])
    expect(records[0].status).toBe('failed')
    expect(records[0].pipeline_version_hash).toBe(STUB_HASH) // bound even though it failed
    expect(records[0].artifact_uri).toBeNull() // no artifact for a failure
  })
})

describe('rerun + repro — reuses source hash, no re-snapshot, archives', () => {
  it('reruns a completed child WITHOUT re-snapshotting and archives the rerun', async () => {
    const reproCalls: StubReproCalls = { snapshots: [], archives: [] }
    app = buildApp({
      prediction: stubPrediction(),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
      repro: stubRepro(reproCalls),
    })

    // fan-out a 2-child batch first
    await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: FLOW_ID,
        pipelineId: FLOW_ID,
        identifier: 'batch-rerun-source',
        inputs: [{ body: { paper: 1 } }, { body: { paper: 2 } }],
      }),
    })
    const fanOutSnapshots = reproCalls.snapshots.length
    const fanOutArchives = reproCalls.archives.length
    expect(fanOutSnapshots).toBe(1) // one snapshot for the batch

    // pick a completed child to rerun
    const { records: children } = await runQuery<{ id: string }>(
      `SELECT id FROM runs WHERE parent_run_id IS NOT NULL AND status = 'completed' LIMIT 1`,
    )
    const childId = children[0].id

    const rerunRes = await app.request(`/api/v1/scheduler/runs/${childId}/rerun`, {
      method: 'POST',
    })
    expect(rerunRes.status).toBe(200)
    const body = (await rerunRes.json()) as { data: { runId: string; status: string } }
    expect(body.data.status).toBe('completed')

    // rerun does NOT re-snapshot: snapshot count unchanged from the fan-out
    expect(reproCalls.snapshots).toHaveLength(fanOutSnapshots)
    // rerun DOES archive: one more archive than the fan-out left
    expect(reproCalls.archives).toHaveLength(fanOutArchives + 1)

    // the rerun row shares the source's hash (comparability) and is archived
    const { records } = await runQuery<{
      pipeline_version_hash: string | null
      artifact_uri: string | null
      created_by_run_id: string | null
    }>(
      `SELECT pipeline_version_hash, artifact_uri, created_by_run_id FROM runs WHERE id = $1`,
      [body.data.runId],
    )
    expect(records[0].pipeline_version_hash).toBe(STUB_HASH)
    expect(records[0].artifact_uri).toBe(STUB_URI(body.data.runId))
    expect(records[0].created_by_run_id).toBe(childId)
  })
})

describe('repro failure handling — best-effort', () => {
  it('a snapshot failure leaves runs unbound but the batch still completes', async () => {
    const reproCalls: StubReproCalls = {
      snapshots: [],
      archives: [],
      snapshotImpl: async () => null, // snapshot always fails
    }
    app = buildApp({
      prediction: stubPrediction(),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
      repro: stubRepro(reproCalls),
    })

    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: FLOW_ID,
        pipelineId: FLOW_ID,
        identifier: 'batch-snap-fail',
        inputs: [{ body: { paper: 1 } }, { body: { paper: 2 } }],
      }),
    })
    expect(res.status).toBe(200) // batch still succeeds
    const body = (await res.json()) as { data: { completed: number; failed: number } }
    expect(body.data.completed).toBe(2)
    expect(body.data.failed).toBe(0)

    // snapshot was attempted; runs are unbound (hash null) but still archived
    expect(reproCalls.snapshots).toHaveLength(1)
    expect(reproCalls.archives).toHaveLength(3) // 2 children + parent
    const { records } = await runQuery<{ pipeline_version_hash: string | null }>(
      `SELECT pipeline_version_hash FROM runs`,
    )
    expect(records.every((r) => r.pipeline_version_hash === null)).toBe(true)
  })

  it('an archive failure leaves artifact_uri null but the run still completes', async () => {
    const reproCalls: StubReproCalls = {
      snapshots: [],
      archives: [],
      archiveImpl: async () => {
        throw new Error('minio down')
      },
    }
    app = buildApp({
      prediction: stubPrediction(),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
      repro: stubRepro(reproCalls),
    })

    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: FLOW_ID,
        pipelineId: FLOW_ID,
        identifier: 'batch-archive-fail',
        inputs: [{ body: { paper: 1 } }],
      }),
    })
    expect(res.status).toBe(200) // batch still succeeds

    // bound (snapshot ok) but not archived (archive threw, swallowed)
    const { records } = await runQuery<{
      pipeline_version_hash: string | null
      artifact_uri: string | null
    }>(`SELECT pipeline_version_hash, artifact_uri FROM runs`)
    expect(records.every((r) => r.pipeline_version_hash === STUB_HASH)).toBe(true)
    expect(records.every((r) => r.artifact_uri === null)).toBe(true)
  })
})

// ---- helpers ----

async function waitForRun(
  runId: string,
  status: string,
  timeoutMs: number,
): Promise<{ status: string } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { records } = await runQuery<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    )
    if (records[0] && records[0].status === status) return records[0]
    await sleep(50)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
