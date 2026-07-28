import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { createRedis } from '@dagents/shared'
import { buildApp } from '../app.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'
import { createRedisSemaphore } from '../semaphore.js'

/**
 * Fan-out integration test (P1.7.T4 / M3.2 acceptance).
 *
 * Drives the scheduler Hono app in-process via `app.request()` against the real
 * Postgres (127.0.0.1:15432) + Redis (127.0.0.1:16479) docker-compose stack.
 * The Prediction client is a stub — it records every call and returns a canned
 * output keyed by the run id — so the test asserts the N→N child mapping and
 * parent aggregation without a live workflow engine.
 *
 * Acceptance (issue description): N=5 inputs → 5 child runs + parent
 * aggregation. Plus: concurrency is bounded, a failed child is recorded as
 * `failed` without aborting the batch, and the parent's status reflects child
 * outcomes.
 *
 * The default URL bakes in the dev Redis password — the dagents Redis runs
 * with `--requirepass dagents_dev`, so a bare URL hits `NOAUTH` and the whole
 * suite skips (see semaphore.test.ts for the full rationale). Override via
 * REDIS_URL for a non-dev stack.
 */
const redisUrl =
  process.env.REDIS_URL ?? 'redis://localhost:16479'
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
      // small delay so concurrency is observable
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
  // wipe runs + the semaphore key so every test starts clean. run_node_spans
  // (M6.4) is wiped too: the fan-out path now ingests child node spans, and a
  // stale span row keyed to a recycled run id would leak across tests.
  await runQuery(`DELETE FROM run_node_spans`)
  await runQuery(`DELETE FROM runs`)
  await redis.del('sem')
  app = buildApp({
    prediction: stubPredictionClient({ calls: [] }),
    semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
    maxConcurrent: 10,
  })
})

describe('POST /api/v1/scheduler/runs/fanout — acceptance (N=5)', () => {
  it('creates 5 child runs + 1 parent and aggregates', async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({ body: { paper: i } }))

    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'flow-abc',
        pipelineId: 'pipe-abc',
        identifier: 'batch-1',
        inputs,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        parentRunId: string
        total: number
        completed: number
        failed: number
        children: { runId: string; status: string }[]
        aggregate: { total: number; completed: number; failed: number }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.total).toBe(5)
    expect(body.data.completed).toBe(5)
    expect(body.data.failed).toBe(0)
    expect(body.data.children).toHaveLength(5)
    expect(body.data.aggregate.total).toBe(5)

    // parent + 5 children = 6 rows in the runs table
    const { records } = await runQuery<{ id: string; parent_run_id: string | null; status: string }>(
      `SELECT id, parent_run_id, status FROM runs ORDER BY created_at`,
    )
    expect(records).toHaveLength(6)
    const parent = records.find((r) => r.parent_run_id === null)!
    expect(parent).toBeDefined()
    const children = records.filter((r) => r.parent_run_id === parent.id)
    expect(children).toHaveLength(5)
    expect(children.every((c) => c.status === 'completed')).toBe(true)
    expect(parent.status).toBe('completed')

    // parent id matches the response
    expect(body.data.parentRunId).toBe(parent.id)
  })

  it('every child run has parent_run_id pointing at the parent', async () => {
    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'f1',
        pipelineId: 'p1',
        identifier: 'batch-tree',
        inputs: [{ body: 'a' }, { body: 'b' }, { body: 'c' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { parentRunId: string } }

    const { records } = await runQuery<{ parent_run_id: string | null }>(
      `SELECT parent_run_id FROM runs WHERE parent_run_id IS NOT NULL`,
    )
    expect(records).toHaveLength(3)
    // every child's parent_run_id is the parent returned by the API
    expect(records.every((r) => r.parent_run_id === body.data.parentRunId)).toBe(true)
  })
})

describe('fan-out failure handling', () => {
  it('records a failed child without aborting the batch; parent status = failed', async () => {
    // rebuild app with a stub that fails every 3rd call (by run id parity is
    // racy under concurrency; instead fail when body.paper === 2)
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
        flowId: 'f',
        pipelineId: 'p',
        identifier: 'batch-fail',
        inputs: [
          { body: { paper: 1 } },
          { body: { paper: 2 } }, // fails
          { body: { paper: 3 } },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { total: number; completed: number; failed: number; aggregate: { failed: number } }
    }
    expect(body.data.total).toBe(3)
    expect(body.data.completed).toBe(2)
    expect(body.data.failed).toBe(1)
    expect(body.data.aggregate.failed).toBe(1)

    // parent is `failed` because at least one child failed
    const { records } = await runQuery<{ status: string; parent_run_id: string | null }>(
      `SELECT status, parent_run_id FROM runs WHERE parent_run_id IS NULL`,
    )
    expect(records[0].status).toBe('failed')
  })

  it('the prediction client is called once per child (N calls)', async () => {
    const calls: PredictionRequest[] = []
    app = buildApp({
      prediction: stubPredictionClient({ calls }),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
      maxConcurrent: 10,
    })
    await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'f',
        pipelineId: 'p',
        identifier: 'batch-count',
        inputs: [{ body: 1 }, { body: 2 }, { body: 3 }, { body: 4 }],
      }),
    })
    expect(calls).toHaveLength(4)
  })
})

describe('fan-out validation', () => {
  it('rejects an empty inputs array with 400', async () => {
    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'f',
        pipelineId: 'p',
        identifier: 'x',
        inputs: [],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing flowId with 400', async () => {
    const res = await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelineId: 'p', identifier: 'x', inputs: [{ body: 1 }] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('concurrency gate (M3.1 reuse)', () => {
  it('bounds concurrent prediction calls to maxConcurrent', async () => {
    let active = 0
    let peak = 0
    const calls: PredictionRequest[] = []
    const gated: PredictionClient = {
      predict: async (req, runId) => {
        calls.push(req)
        active += 1
        peak = Math.max(peak, active)
        await sleep(30)
        active -= 1
        return { runId, output: { ok: true }, durationMs: 31 }
      },
    }
    app = buildApp({
      prediction: gated,
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 2, semKey: 'sem' }),
      maxConcurrent: 2,
    })

    await app.request('/api/v1/scheduler/runs/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'f',
        pipelineId: 'p',
        identifier: 'batch-gate',
        inputs: Array.from({ length: 6 }, (_, i) => ({ body: { i } })),
      }),
    })

    // 6 predictions, gate of 2 → peak concurrency never exceeds 2
    expect(calls).toHaveLength(6)
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('GET /health', () => {
  it('reports ok with db initialized', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; svc: string; db: boolean }
    expect(body.ok).toBe(true)
    expect(body.svc).toBe('scheduler')
    expect(body.db).toBe(true)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
