import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { createRedis } from '@dagents/shared'
import { buildApp } from '../app.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'
import { createRedisSemaphore } from '../semaphore.js'
import { createMemoryArtifactStore, createThrowingArtifactStore } from './mem-artifact-store.js'

/**
 * Reproduce integration test (plan M4.3 / P1.8.T5 acceptance).
 *
 * Drives the scheduler Hono app in-process via `app.request()` against the real
 * Postgres (127.0.0.1:15432) + Redis (127.0.0.1:16479) docker-compose stack,
 * same harness as rerun.test.ts. The Prediction client is a stub so the test
 * asserts the reproduce contract — same hash + same input re-run + structural
 * compare + report archived — without a live Flowise. The artifact store is an
 * in-memory stub (the real MinIO store is covered by @dagents/repro's own suite).
 *
 * Acceptance (issue description): "同 hash + 同 input 重跑 + 比对, 复现报告生成,
 * 结果可比对 (非字节级)" —
 *   - same hash + same input re-run + compare → reproduceRun re-executes the
 *     source's input + hash + flow and structurally compares the output
 *   - 复现报告生成 → a JSON report is archived as the re-run's artifact_uri
 *   - 结果可比对 (非字节级) → a re-run that differs only by object key order
 *     still compares equal (canonical, not byte-for-byte)
 */
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:16479'
const redis = createRedis(redisUrl)

const HASH = 'a'.repeat(64) // pipeline_version_hash is CHAR(64)

/**
 * Stub prediction client. `outputFor` lets a test decide what the *re-run*
 * produces — the same stub serves the original fan-out (which records the
 * baseline) and the reproduce (which produces the comparison output).
 */
function stubPredictionClient(
  log: { calls: PredictionRequest[] },
  outputFor?: (req: PredictionRequest, runId: string) => unknown,
  failOn?: (req: PredictionRequest, runId: string) => boolean,
): PredictionClient {
  return {
    predict: async (req, runId): Promise<PredictionResult> => {
      log.calls.push(req)
      if (failOn?.(req, runId)) {
        throw new Error(`stub failure for ${runId}`)
      }
      await sleep(5)
      const output = outputFor ? outputFor(req, runId) : { ok: true, echoed: req.body, runId }
      return { runId, output, durationMs: 9 }
    },
  }
}

let app: ReturnType<typeof buildApp>
let store: ReturnType<typeof createMemoryArtifactStore>

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
  store = createMemoryArtifactStore()
  app = buildApp({
    prediction: stubPredictionClient({ calls: [] }),
    semaphore: createRedisSemaphore({ redis, maxConcurrent: 10, semKey: 'sem' }),
    maxConcurrent: 10,
    artifactStore: store,
  })
})

/**
 * Fan out a 1-child batch (parent + 1 completed child) bound to HASH, then
 * return the completed child — the "source" run to reproduce. The fan-out path
 * already stamps pipeline_version_hash on every run, so the child is bound.
 */
async function seedCompletedSource(
  input: unknown = { paper: 1 },
  output: unknown = { ok: true, paper: 1 },
): Promise<string> {
  const calls: PredictionRequest[] = []
  app = buildApp({
    prediction: stubPredictionClient({ calls }, () => output),
    semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
    maxConcurrent: 5,
    artifactStore: store,
  })
  const res = await app.request('/api/v1/scheduler/runs/fanout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flowId: 'flow-repro',
      pipelineId: 'pipe-repro',
      identifier: 'batch-source',
      pipelineVersionHash: HASH,
      inputs: [{ body: input }],
    }),
  })
  expect(res.status).toBe(200)
  const { records } = await runQuery<{ id: string; status: string }>(
    `SELECT id, status FROM runs WHERE parent_run_id IS NOT NULL AND status = 'completed' LIMIT 1`,
  )
  expect(records[0]).toBeDefined()
  return records[0].id
}

describe('POST /api/v1/scheduler/runs/:runId/reproduce — acceptance', () => {
  it('re-runs with the same hash + input and compares equal on identical output (non-byte-level)', async () => {
    // baseline output has keys in one order; the re-run returns them reordered.
    // Structural (canonical) compare must still match — "非字节级".
    const baseline = { ok: true, count: 3, items: [{ id: 1 }, { id: 2 }] }
    const sourceId = await seedCompletedSource({ paper: 1 }, baseline)

    const reproCalls: PredictionRequest[] = []
    app = buildApp({
      prediction: stubPredictionClient(
        { calls: reproCalls },
        () => ({ items: [{ id: 1 }, { id: 2 }], count: 3, ok: true }), // reordered keys
      ),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
      artifactStore: store,
    })

    const res = await app.request(`/api/v1/scheduler/runs/${sourceId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        sourceRunId: string
        rerunRunId: string
        status: string
        match: boolean
        diff: string | null
        versionHash: string
        artifactUri: string | null
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.sourceRunId).toBe(sourceId)
    expect(body.data.rerunRunId).not.toBe(sourceId)
    expect(body.data.status).toBe('completed')
    expect(body.data.match).toBe(true)
    expect(body.data.diff).toBeNull()
    expect(body.data.versionHash).toBe(HASH)

    // the re-run predicted against the SAME flow id + input as the source
    expect(reproCalls).toHaveLength(1)
    expect(reproCalls[0].flowId).toBe('flow-repro')
    expect(reproCalls[0].body).toEqual({ paper: 1 })

    // the re-run row shares the source's comparable identity + provenance
    const rerunRow = await runQuery<{
      status: string
      input: unknown
      pipeline_version_hash: string | null
      parent_run_id: string | null
      created_by_run_id: string | null
    }>(
      `SELECT status, input, pipeline_version_hash, parent_run_id, created_by_run_id
         FROM runs WHERE id = $1`,
      [body.data.rerunRunId],
    )
    const rr = rerunRow.records[0]
    expect(rr.status).toBe('completed')
    expect(rr.input).toEqual({ paper: 1 })
    expect(rr.pipeline_version_hash).toBe(HASH)
    expect(rr.created_by_run_id).toBe(sourceId)
  })

  it('diverges (match=false + diff) when the re-run output differs structurally', async () => {
    const sourceId = await seedCompletedSource({ paper: 1 }, { ok: true, count: 3 })

    app = buildApp({
      prediction: stubPredictionClient({ calls: [] }, () => ({ ok: true, count: 4 })),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
      artifactStore: store,
    })

    const res = await app.request(`/api/v1/scheduler/runs/${sourceId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { match: boolean; diff: string | null; status: string }
    }
    expect(body.data.match).toBe(false)
    expect(body.data.diff).not.toBeNull()
    expect(body.data.status).toBe('completed')
  })

  it('archives a reproduce report to the re-run row artifact_uri and round-trips via get', async () => {
    const sourceId = await seedCompletedSource({ paper: 1 }, { ok: true, paper: 1 })

    app = buildApp({
      prediction: stubPredictionClient({ calls: [] }, () => ({ ok: true, paper: 1 })),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
      artifactStore: store,
    })

    const res = await app.request(`/api/v1/scheduler/runs/${sourceId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { rerunRunId: string; artifactUri: string | null } }
    expect(body.data.artifactUri).toMatch(/^s3:\/\/test-bucket\/runs\//)

    // the re-run row's artifact_uri was written
    const { records } = await runQuery<{ uri: string | null }>(
      `SELECT artifact_uri AS uri FROM runs WHERE id = $1`,
      [body.data.rerunRunId],
    )
    expect(records[0].uri).toBe(body.data.artifactUri)

    // round-trip: the archived report is a JSON blob with the verdict + schema
    const fetched = await store.get(body.data.artifactUri!)
    const report = JSON.parse(Buffer.from(fetched.bytes).toString('utf8'))
    expect(report.schema).toBe('mil.repro.report/v1')
    expect(report.sourceRunId).toBe(sourceId)
    expect(report.rerunRunId).toBe(body.data.rerunRunId)
    expect(report.match).toBe(true)
    expect(report.versionHash).toBe(HASH)
  })

  it('degrades gracefully when the artifact store PUT fails (verdict still 200, artifactUri=null)', async () => {
    // Archive failure (MinIO down / credentials / bucket missing) must NOT
    // hide an already-computed match/diff — the re-run row + comparison
    // succeeded before the PUT, so the route returns 200 with artifactUri=null
    // rather than 502 (review MEDIUM#3).
    const sourceId = await seedCompletedSource({ paper: 1 }, { ok: true, paper: 1 })

    app = buildApp({
      prediction: stubPredictionClient({ calls: [] }, () => ({ ok: true, paper: 1 })),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
      artifactStore: createThrowingArtifactStore('minio down'),
    })

    const res = await app.request(`/api/v1/scheduler/runs/${sourceId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { rerunRunId: string; match: boolean; diff: string | null; artifactUri: string | null }
    }
    // the verdict survived the archive failure
    expect(body.data.match).toBe(true)
    expect(body.data.diff).toBeNull()
    expect(body.data.artifactUri).toBeNull()

    // the re-run row's artifact_uri was NOT written (PUT failed before the URI write)
    const { records } = await runQuery<{ uri: string | null }>(
      `SELECT artifact_uri AS uri FROM runs WHERE id = $1`,
      [body.data.rerunRunId],
    )
    expect(records[0].uri).toBeNull()
  })
})

describe('reproduce failure handling + comparability', () => {
  it('a reproduce whose re-run fails is recorded failed and stays comparable to the source', async () => {
    const sourceId = await seedCompletedSource({ paper: 1 }, { ok: true })

    // re-run stub that always fails — reproduce must not throw; it lands the
    // re-run as `failed` and still reports a (non-matching) comparison.
    app = buildApp({
      prediction: stubPredictionClient({ calls: [] }, undefined, () => true),
      semaphore: createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' }),
      maxConcurrent: 5,
      artifactStore: store,
    })

    const res = await app.request(`/api/v1/scheduler/runs/${sourceId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { status: string; match: boolean; rerunRunId: string } }
    expect(body.data.status).toBe('failed')
    expect(body.data.match).toBe(false)

    // the failed re-run row still shares the source's comparable identity
    const { records } = await runQuery<{
      status: string
      input: unknown
      pipeline_version_hash: string | null
      created_by_run_id: string | null
    }>(
      `SELECT status, input, pipeline_version_hash, created_by_run_id
         FROM runs WHERE id = $1`,
      [body.data.rerunRunId],
    )
    expect(records[0].status).toBe('failed')
    expect(records[0].input).toEqual({ paper: 1 })
    expect(records[0].pipeline_version_hash).toBe(HASH)
    expect(records[0].created_by_run_id).toBe(sourceId)
  })
})

describe('reproduce error guards', () => {
  it('returns 404 for a run id that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    const res = await app.request(`/api/v1/scheduler/runs/${missing}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string; code: string }
    expect(body.success).toBe(false)
    expect(body.code).toBe('not_found')
  })

  it('returns 409 when the source run is still in flight (pending)', async () => {
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO runs (identifier, pipeline_id, status, input, pipeline_version_hash)
         VALUES ('inflight', 'pipe', 'pending', '{}'::jsonb, $1)
         RETURNING id`,
      [HASH],
    )
    const pendingId = records[0].id

    const res = await app.request(`/api/v1/scheduler/runs/${pendingId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { success: boolean; code: string }
    expect(body.success).toBe(false)
    expect(body.code).toBe('in_flight')

    // no reproduce re-run row was created
    const { records: reruns } = await runQuery<{ id: string }>(
      `SELECT id FROM runs WHERE created_by_run_id = $1`,
      [pendingId],
    )
    expect(reruns).toHaveLength(0)
  })

  it('returns 422 when the source run is not completed (no baseline)', async () => {
    // a failed run has no meaningful baseline output to compare against
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO runs (identifier, pipeline_id, status, input, pipeline_version_hash)
         VALUES ('failed-src', 'pipe', 'failed', '{}'::jsonb, $1)
         RETURNING id`,
      [HASH],
    )
    const failedId = records[0].id

    const res = await app.request(`/api/v1/scheduler/runs/${failedId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { success: boolean; code: string }
    expect(body.success).toBe(false)
    expect(body.code).toBe('not_completed')
  })

  it('returns 422 when the source run has no pipeline_version_hash (unbound)', async () => {
    // a completed run that was never bound to a snapshot
    const { records } = await runQuery<{ id: string }>(
      `INSERT INTO runs (identifier, pipeline_id, status, input, output)
         VALUES ('unbound', 'pipe', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)
         RETURNING id`,
    )
    const unboundId = records[0].id

    const res = await app.request(`/api/v1/scheduler/runs/${unboundId}/reproduce`, {
      method: 'POST',
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { success: boolean; code: string }
    expect(body.success).toBe(false)
    expect(body.code).toBe('unbound')
  })

  it('returns 400 for a malformed (non-uuid) runId', async () => {
    const res = await app.request('/api/v1/scheduler/runs/not-a-uuid/reproduce', {
      method: 'POST',
    })
    expect(res.status).toBe(400)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
