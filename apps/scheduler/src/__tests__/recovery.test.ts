import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@mil/db'
import { createRedis } from '@mil/shared'
import type { RedisClient } from '@mil/shared'
import { recoverStaleRuns, listStaleRuns, resetSemaphore } from '../recovery.js'
import { createRedisSemaphore, availableSlots } from '../semaphore.js'
import { TASK_QUEUE_KEY } from '../queue.js'
import { startWorker } from '../worker.js'
import { getRun } from '../runs-repo.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'

/**
 * Restart-recovery integration test (plan M3.5 / P1.7.T8 — 断点续跑).
 *
 * Drives the real milagents Postgres (`runs`) + Redis (`mil:tasks`,
 * `mil:sem`) from the docker-compose stack. Recovery is exercised against the
 * actual `runs` rows and Redis keys the worker uses — no mocks of the repo or
 * the semaphore — so the test asserts the real crash→restart contract.
 *
 * Acceptance (issue description): "kill scheduler 后重启, 未完成 run 续跑."
 * The end-to-end case simulates a kill mid-run (a `running` row + a leaked
 * semaphore slot, with the queue task already BRPOP'd away), then runs
 * `recoverStaleRuns` + `startWorker` and asserts the run reaches `completed`.
 *
 * The default URL bakes in the dev Redis password — the mil-agents Redis runs
 * with `--requirepass milagents_dev`, so a bare URL hits `NOAUTH` and the
 * suite skips (see semaphore.test.ts for the full rationale).
 */

const redisUrl =
  process.env.REDIS_URL ?? 'redis://localhost:16479'
let redis: RedisClient

beforeAll(async () => {
  redis = createRedis(redisUrl)
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  await redis.raw().ping()
})

afterAll(async () => {
  await redis.raw().quit()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  await redis.del(TASK_QUEUE_KEY)
  await redis.del('sem')
  await AppDataSource.query(`DELETE FROM runs`)
})

afterEach(async () => {
  await redis.del(TASK_QUEUE_KEY)
  await redis.del('sem')
  await AppDataSource.query(`DELETE FROM runs`)
})

/** Insert a run row directly at a given status (simulates a crashed run). */
async function seedRun(
  status: 'pending' | 'running' | 'completed' | 'failed',
  pipelineId = 'flow-recovered',
  input: unknown = { question: 'hi' },
): Promise<string> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [id, id, pipelineId, status, JSON.stringify(input)],
  )
  return id
}

/** Drain `mil:tasks` and return the parsed payloads (FIFO: oldest first). */
async function drainQueue(): Promise<unknown[]> {
  const out: unknown[] = []
  for (;;) {
    const raw = await redis.brpop(TASK_QUEUE_KEY, 1)
    if (raw === null) break
    out.push(JSON.parse(raw))
  }
  return out
}

/** A stub prediction client that resolves immediately with a canned output. */
function stubPrediction(): PredictionClient {
  return {
    predict: async (req: PredictionRequest, runId: string): Promise<PredictionResult> => {
      await sleep(5)
      return { runId, output: { ok: true, echoed: req.body, runId }, durationMs: 6 }
    },
  }
}

describe('listStaleRuns', () => {
  it('returns only rows with status=running', async () => {
    const running1 = await seedRun('running')
    const running2 = await seedRun('running')
    await seedRun('pending')
    await seedRun('completed')
    await seedRun('failed')

    const stale = await listStaleRuns()
    const ids = stale.map((r) => r.id).sort()
    expect(ids).toEqual([running1, running2].sort())
    // each carries its pipeline + input for re-enqueue
    expect(stale[0].pipelineId).toBe('flow-recovered')
    expect(stale[0].input).toEqual({ question: 'hi' })
  })

  it('returns [] when no runs are running', async () => {
    await seedRun('pending')
    await seedRun('completed')
    expect(await listStaleRuns()).toEqual([])
  })
})

describe('resetSemaphore', () => {
  it('clears a leaked counter back to 0 (full budget on restart)', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    // Simulate two leaked slots: acquired but never released (process killed).
    expect((await sem.acquire()).acquired).toBe(true)
    expect((await sem.acquire()).acquired).toBe(true)
    expect(await sem.count()).toBe(2)
    expect(await availableSlots(sem, 4)).toBe(2) // 2 of 4 leaked

    await resetSemaphore(sem)

    expect(await sem.count()).toBe(0)
    expect(await availableSlots(sem, 4)).toBe(4) // full budget restored
  })
})

describe('recoverStaleRuns', () => {
  it('re-enqueues a running run onto mil:tasks and resets the semaphore', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    // Leak a slot (kill mid-run) and leave a running row whose queue task was
    // already BRPOP'd (so it can only be recovered via the runs scan).
    expect((await sem.acquire()).acquired).toBe(true)
    const runId = await seedRun('running', 'flow-1', { question: 'hello' })
    expect(await sem.count()).toBe(1)

    const result = await recoverStaleRuns({ redis, semaphore: sem })

    expect(result.recovered).toBe(1)
    expect(result.runIds).toEqual([runId])
    expect(result.semReset).toBe(true)
    // semaphore zeroed
    expect(await sem.count()).toBe(0)
    // the run was re-enqueued as a ScheduleTask
    const queued = await drainQueue()
    expect(queued).toEqual([
      { runId, pipelineId: 'flow-1', input: { question: 'hello' } },
    ])
  })

  it('re-enqueues multiple running runs in started_at order', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    // Seed three running rows with explicit, increasing started_at so the
    // recovery scan's ORDER BY started_at yields a deterministic enqueue order.
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const base = Date.now() - 60_000
    for (const [i, id] of ids.entries()) {
      const startedAt = new Date(base + i * 1000).toISOString()
      // $1 = id (uuid), $2 = identifier (text) — separate params because
      // Postgres can't deduce one type for $1 across a uuid and a text column.
      await runQuery(
        `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at, created_at)
         VALUES ($1, $2, $3, 'running', $4, $5, NOW())`,
        [id, id, 'flow-ord', JSON.stringify({ i }), startedAt],
      )
    }

    const result = await recoverStaleRuns({ redis, semaphore: sem })

    expect(result.recovered).toBe(3)
    expect(result.runIds).toEqual(ids) // enqueue order matches started_at order
    const queued = await drainQueue()
    expect(queued.map((t) => (t as { runId: string }).runId)).toEqual(ids)
  })

  it('is a no-op when there are no stale runs (empty queue, zero counter)', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    await seedRun('pending')
    await seedRun('completed')

    const result = await recoverStaleRuns({ redis, semaphore: sem })

    expect(result.recovered).toBe(0)
    expect(result.runIds).toEqual([])
    // queue stays empty
    expect(await redis.brpop(TASK_QUEUE_KEY, 1)).toBeNull()
  })

  it('never enqueues pending or terminal runs', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    await seedRun('pending')
    await seedRun('completed')
    await seedRun('failed')

    const result = await recoverStaleRuns({ redis, semaphore: sem })

    expect(result.recovered).toBe(0)
    expect(await redis.brpop(TASK_QUEUE_KEY, 1)).toBeNull()
  })
})

describe('restart recovery — end-to-end acceptance (kill → restart → 续跑)', () => {
  it('recovers a run left running by a killed scheduler', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 2, semKey: 'sem' })
    const prediction = stubPrediction()

    // --- "before the kill" ---
    // A run was dequeued and flipped to running, holding one semaphore slot.
    // Then SIGKILL: the slot is leaked (no DECR) and the BRPOP'd task is gone.
    const runId = await seedRun('running', 'flow-e2e', { paper: 7 })
    expect((await sem.acquire()).acquired).toBe(true) // leaked slot
    expect(await sem.count()).toBe(1)
    // mil:tasks is empty — the task that started this run was already consumed
    expect(await redis.brpop(TASK_QUEUE_KEY, 1)).toBeNull()

    // --- "restart" ---
    // 1. recovery runs first: zero the leaked counter + re-enqueue the run.
    const recovered = await recoverStaleRuns({ redis, semaphore: sem })
    expect(recovered.recovered).toBe(1)
    expect(recovered.runIds).toEqual([runId])
    expect(await sem.count()).toBe(0) // leaked slot cleared

    // 2. the worker starts on the recovered queue and drains it.
    const worker = startWorker({ redis, semaphore: sem, prediction })
    try {
      const run = await waitForRun(runId, 'completed', 3000)
      expect(run).not.toBeNull()
      expect(run!.status).toBe('completed')
      expect(run!.output).toEqual({ ok: true, echoed: { paper: 7 }, runId })
      expect(run!.durationMs).not.toBeNull()
    } finally {
      await worker.stop()
    }
    // full budget restored after the run completes + worker stops
    expect(await availableSlots(sem, 2)).toBe(2)
  })

  it('recovers multiple runs and bounds concurrency to maxConcurrent', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 2, semKey: 'sem' })

    // Two runs were in flight when the process was killed, both holding a slot.
    const id1 = await seedRun('running', 'flow-c', { n: 1 })
    const id2 = await seedRun('running', 'flow-c', { n: 2 })
    expect((await sem.acquire()).acquired).toBe(true)
    expect((await sem.acquire()).acquired).toBe(true)
    expect(await sem.count()).toBe(2) // gate saturated by leaks

    // Recover: counter cleared, both runs re-enqueued.
    const recovered = await recoverStaleRuns({ redis, semaphore: sem })
    expect(recovered.recovered).toBe(2)
    expect(await sem.count()).toBe(0)

    let active = 0
    let peak = 0
    const gated: PredictionClient = {
      predict: async (req, runId) => {
        active += 1
        peak = Math.max(peak, active)
        await sleep(30)
        active -= 1
        return { runId, output: { ok: true, echoed: req.body }, durationMs: 31 }
      },
    }
    const worker = startWorker({ redis, semaphore: sem, prediction: gated })
    try {
      await waitForRun(id1, 'completed', 3000)
      await waitForRun(id2, 'completed', 3000)
      expect(peak).toBeLessThanOrEqual(2) // never exceeded the cap despite 2 re-enqueued
    } finally {
      await worker.stop()
    }
  })
})

// ---- helpers ----

/** Poll `runs` until `runId` reaches `status`, or timeout. Returns the row. */
async function waitForRun(
  runId: string,
  status: string,
  timeoutMs: number,
): Promise<{ status: string; output: unknown; durationMs: number | null } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await getRun(runId)
    if (run && run.status === status) return run
    await sleep(50)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
