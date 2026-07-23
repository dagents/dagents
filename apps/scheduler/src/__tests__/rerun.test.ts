import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { AppDataSource, runQuery } from '@mil/db'
import { createRedis } from '@mil/shared'
import { buildApp } from '../app.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'
import { createRedisSemaphore } from '../semaphore.js'

/**
 * Failed-run rerun integration test (P1.7.T5 / M3.4 acceptance).
 *
 * Drives the scheduler Hono app in-process via `app.request()` against the real
 * Postgres (127.0.0.1:15432) + Redis (127.0.0.1:16479) docker-compose stack,
 * same harness as fanout.test.ts. The Prediction client is a stub so the test
 * asserts the rerun identity contract (same hash + input + parent) without a
 * live Flowise.
 *
 * Acceptance (issue description): "失败子 run 可单独重跑, 结果可比对" — a failed
 * child reruns into a NEW run that shares the source's pipeline_version_hash +
 * input + parent_run_id, while the source row is left untouched. Plus the
 * error guards: 404 for a missing run, 409 for an in-flight run, 400 for a
 * malformed id, and the "fails again" path stays comparable.
 *
 * The default URL bakes in the dev Redis password — see fanout.test.ts for the
 * NOAUTH rationale. Override via REDIS_URL for a non-dev stack.
 */
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:16479'
const redis = createRedis(redisUrl)

/** Stub prediction client: records calls, returns runId-keyed output. */
function stubPredictionClient(
  log: { calls: PredictionRequest[] },
  failOn?: (req: PredictionRequest, runId: string) => boolean,
): PredictionClient {
  return {
    predict: async (req, runId): Promise<PredictionResult> => {
      log.calls.push(req)
      if (failOn?.(req, runId)) {
        throw new Error(`stub failure for ${runId}`)
      }
      await sleep(10)
      return { runId, output: { ok: true, echoed: req.body, runId }, durationMs: 12 }
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
  // wipe runs + the semaphore key so every test starts clean
  await runQuery(`DELETE FROM runs`)
  await redis.del('sem')
  app = buildApp({
    prediction: stubPredictionClient({ calls: [] }),
    semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
    maxConcurrent: 10,
  })
})

const HASH = 'a'.repeat(64) // pipeline_version_hash is CHAR(64)

/** Run a 3-child fan-out where the `paper===2` child fails; return the failed child + parent. */
async function fanOutWithOneFailure(): Promise<{
  failedChildId: string
  parentId: string
}> {
  const calls: PredictionRequest[] = []
  app = buildApp({
    prediction: stubPredictionClient(
      { calls },
      (req) => (req.body as { paper?: number }).paper === 2,
    ),
    semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
    maxConcurrent: 5,
  })

  const res = await app.request('/api/v1/scheduler/runs/fanout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flowId: 'flow-abc',
      pipelineId: 'pipe-abc',
      identifier: 'batch-fail',
      pipelineVersionHash: HASH,
      inputs: [
        { body: { paper: 1 } },
        { body: { paper: 2 } }, // fails
        { body: { paper: 3 } },
      ],
    }),
  })
  expect(res.status).toBe(200)

  const { records } = await runQuery<{
    id: string
    parent_run_id: string | null
    status: string
  }>(`SELECT id, parent_run_id, status FROM runs ORDER BY created_at`)
  const parent = records.find((r) => r.parent_run_id === null)!
  const failed = records.find((r) => r.status === 'failed' && r.parent_run_id === parent.id)!
  expect(failed).toBeDefined()
  return { failedChildId: failed.id, parentId: parent.id }
}

describe('POST /api/v1/scheduler/runs/:runId/rerun — acceptance', () => {
  it('reruns a failed child into a new completed run with the same hash + input + parent; source unchanged', async () => {
    const { failedChildId, parentId } = await fanOutWithOneFailure()

    // snapshot the source row BEFORE rerun so we can prove it is untouched after
    const before = await runQuery<{
      status: string
      input: unknown
      output: unknown
      pipeline_version_hash: string | null
      parent_run_id: string | null
    }>(
      `SELECT status, input, output, pipeline_version_hash, parent_run_id
         FROM runs WHERE id = $1`,
      [failedChildId],
    )
    expect(before.records[0].status).toBe('failed')

    // rebuild the app with a SUCCEEDING stub so the rerun completes — the
    // original failure is what we are recovering from
    const rerunCalls: PredictionRequest[] = []
    app = buildApp({
      prediction: stubPredictionClient({ calls: rerunCalls }),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
    })

    const res = await app.request(
      `/api/v1/scheduler/runs/${failedChildId}/rerun`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        runId: string
        sourceRunId: string
        status: string
        output: unknown
        durationMs: number
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.sourceRunId).toBe(failedChildId)
    expect(body.data.runId).not.toBe(failedChildId)
    expect(body.data.status).toBe('completed')

    // the rerun predicted against the SAME flow id as the original fan-out
    expect(rerunCalls).toHaveLength(1)
    expect(rerunCalls[0].flowId).toBe('flow-abc')
    expect(rerunCalls[0].body).toEqual({ paper: 2 })

    // the rerun row carries the source's comparable identity + provenance
    const rerunRow = await runQuery<{
      status: string
      input: unknown
      pipeline_version_hash: string | null
      parent_run_id: string | null
      created_by_run_id: string | null
    }>(
      `SELECT status, input, pipeline_version_hash, parent_run_id, created_by_run_id
         FROM runs WHERE id = $1`,
      [body.data.runId],
    )
    const rr = rerunRow.records[0]
    expect(rr.status).toBe('completed')
    expect(rr.input).toEqual({ paper: 2 })
    expect(rr.pipeline_version_hash).toBe(HASH)
    expect(rr.parent_run_id).toBe(parentId)
    expect(rr.created_by_run_id).toBe(failedChildId)

    // the SOURCE row is untouched — same status / output / hash / parent as
    // before the rerun (provenance + comparability: the original is preserved)
    const after = await runQuery<{
      status: string
      input: unknown
      output: unknown
      pipeline_version_hash: string | null
      parent_run_id: string | null
    }>(
      `SELECT status, input, output, pipeline_version_hash, parent_run_id
         FROM runs WHERE id = $1`,
      [failedChildId],
    )
    expect(after.records[0]).toEqual(before.records[0])

    // the two runs are comparable by identity: same hash + input + parent
    expect(after.records[0].pipeline_version_hash).toBe(rr.pipeline_version_hash)
    expect(after.records[0].input).toEqual(rr.input)
    expect(after.records[0].parent_run_id).toBe(rr.parent_run_id)
  })

  it('reruns a completed run into a new completed run (repro semantics, not only failures)', async () => {
    // all-success fan-out
    app = buildApp({
      prediction: stubPredictionClient({ calls: [] }),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
    })
    await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'flow-x',
        pipelineId: 'pipe-x',
        identifier: 'batch-ok',
        pipelineVersionHash: HASH,
        inputs: [{ body: { paper: 1 } }, { body: { paper: 2 } }],
      }),
    })

    const { records } = await runQuery<{ id: string; status: string }>(
      `SELECT id, status FROM runs WHERE parent_run_id IS NOT NULL AND status = 'completed' LIMIT 1`,
    )
    const completedChild = records[0]
    expect(completedChild).toBeDefined()

    const res = await app.request(
      `/api/v1/scheduler/runs/${completedChild.id}/rerun`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { status: string; sourceRunId: string } }
    expect(body.data.status).toBe('completed')
    expect(body.data.sourceRunId).toBe(completedChild.id)
  })
})

describe('rerun failure handling + comparability', () => {
  it('a rerun that fails again is recorded failed and stays comparable to the source', async () => {
    const { failedChildId } = await fanOutWithOneFailure()

    // rerun with a stub that ALWAYS fails — the rerun must not throw, it must
    // land as a `failed` run that is still comparable (same hash + input)
    app = buildApp({
      prediction: stubPredictionClient(
        { calls: [] },
        () => true, // every prediction fails
      ),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
    })

    const res = await app.request(
      `/api/v1/scheduler/runs/${failedChildId}/rerun`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { runId: string; status: string } }
    expect(body.data.status).toBe('failed')

    const { records } = await runQuery<{
      status: string
      input: unknown
      pipeline_version_hash: string | null
      created_by_run_id: string | null
    }>(
      `SELECT status, input, pipeline_version_hash, created_by_run_id
         FROM runs WHERE id = $1`,
      [body.data.runId],
    )
    expect(records[0].status).toBe('failed')
    expect(records[0].input).toEqual({ paper: 2 })
    expect(records[0].pipeline_version_hash).toBe(HASH)
    expect(records[0].created_by_run_id).toBe(failedChildId)
  })
})

describe('rerun error guards', () => {
  it('returns 404 for a run id that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    const res = await app.request(`/api/v1/scheduler/runs/${missing}/rerun`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string; code: string }
    expect(body.success).toBe(false)
    expect(body.code).toBe('not_found')
  })

  it('returns 409 when the source run is still in flight (pending)', async () => {
    // insert a pending run directly — simulates a run queued but not yet executed
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO runs (identifier, pipeline_id, status, input)
         VALUES ('inflight', 'pipe', 'pending', '{}'::jsonb)
         RETURNING id`,
    )
    const pendingId = records[0].id

    const res = await app.request(`/api/v1/scheduler/runs/${pendingId}/rerun`, {
      method: 'POST',
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { success: boolean; code: string }
    expect(body.success).toBe(false)
    expect(body.code).toBe('in_flight')

    // no rerun row was created
    const { records: reruns } = await runQuery<{ id: string }>(
      `SELECT id FROM runs WHERE created_by_run_id = $1`,
      [pendingId],
    )
    expect(reruns).toHaveLength(0)
  })

  it('returns 400 for a malformed (non-uuid) runId', async () => {
    const res = await app.request('/api/v1/scheduler/runs/not-a-uuid/rerun', {
      method: 'POST',
    })
    expect(res.status).toBe(400)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
