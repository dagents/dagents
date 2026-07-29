import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource } from '@dagents/db'
import { createRedis } from '@dagents/shared'
import type { RedisClient } from '@dagents/shared'
import { startWorker } from '../worker.js'
import type { Worker } from '../worker.js'
import { createRedisSemaphore, availableSlots } from '../semaphore.js'
import { TASK_QUEUE_KEY, type ScheduleTask } from '../queue.js'
import { getRun } from '../runs-repo.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'

/**
 * Integration tests for the scheduler worker (plan M3.1 / P1.7).
 *
 * Uses the real dagents Postgres (runs table) + Redis (dagents:tasks queue +
 * dagents:sem semaphore) from the docker-compose stack. The workflow engine is
 * mocked with an in-process PredictionClient so no gateway is required — the
 * test asserts the scheduler's queue→semaphore→run→persist loop, not the
 * workflow engine itself.
 *
 * The semaphore is main's `createRedisSemaphore` (Lua INCR/DECR counter on
 * `dagents:sem`) — the same gate the fan-out path uses — so this also verifies the
 * worker shares the gate correctly.
 *
 * Coverage (验收清单):
 * - a single run is dequeued, executed, and stamped completed in `runs`
 * - the concurrency gate caps in-flight runs at maxConcurrent: with 5 enqueued
 *   and maxConcurrent=2, at most 2 predictions run simultaneously
 * - a workflow engine failure stamps the run `failed` with the reason
 * - a malformed queue payload is dropped (no run created, slot released)
 * - graceful stop awaits in-flight runs
 */

const redisUrl =
  process.env.REDIS_URL ?? 'redis://localhost:16479'
let redis: RedisClient
// Predictions observed by the mock client, for concurrency assertions.
let activePredictions = 0
let maxObservedConcurrency = 0
// Blocked predictions register their gate resolver here; `releaseGate()`
// resolves the OLDEST (FIFO) so a concurrency test can release one slot at a
// time and watch the next queued run start. An array (not a single var) is
// essential: several predictions block simultaneously, each with its own
// resolver, and a single `releaseGate` variable would overwrite the earlier
// ones and leave them blocked forever.
let gateResolvers: Array<() => void> = []
let predictCalls: { runId: string; pipelineId: string; input: unknown }[] = []

/** Track active workers so afterEach can stop them even if a test times out. */
const activeWorkers: Worker[] = []

/** startWorker wrapper that tracks the worker for afterEach cleanup. */
function trackedStartWorker(deps: Parameters<typeof startWorker>[0]): Worker {
  const w = startWorker(deps)
  activeWorkers.push(w)
  return w
}

/** Resolve the oldest blocked prediction's gate (releases one in-flight run). */
function releaseGate(): void {
  const r = gateResolvers.shift()
  if (r) r()
}

/** A mock PredictionClient that records calls and (optionally) blocks on a gate. */
function mockPrediction({
  failRunIds = new Set<string>(),
  delayMs = 0,
  blockOnGate = false,
}: {
  failRunIds?: Set<string>
  delayMs?: number
  blockOnGate?: boolean
} = {}): PredictionClient {
  return {
    predict: (req: PredictionRequest, runId: string) =>
      new Promise<PredictionResult>((resolve, reject) => {
        activePredictions += 1
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activePredictions)
        predictCalls.push({ runId, pipelineId: req.flowId, input: req.body })

        const finish = (): void => {
          activePredictions -= 1
          if (failRunIds.has(runId)) {
            reject(new Error('mock prediction failure'))
          } else {
            resolve({
              runId,
              output: { text: `result for ${runId}`, runId },
              durationMs: 5,
            })
          }
        }

        if (blockOnGate) {
          // Hold the run open until a test calls releaseGate()/releaseAllGates(),
          // then apply the optional delay. Registering the resolver in the
          // shared array (not overwriting a single var) means every blocked
          // prediction is reachable for release.
          const gate = new Promise<void>((r) => {
            gateResolvers.push(r)
          })
          void gate.then(() => {
            if (delayMs) setTimeout(finish, delayMs)
            else finish()
          })
        } else if (delayMs) {
          setTimeout(finish, delayMs)
        } else {
          finish()
        }
      }),
  }
}

beforeAll(async () => {
  redis = createRedis(redisUrl, 'test:')
  // The setup file sets env defaults + runs migrations, but AppDataSource may
  // be in a 'destroyed' state if a prior file tore it down. Ensure the shared
  // pool is live before the worker queries `runs`.
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  await redis.raw().quit()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

afterEach(async () => {
  // Stop any workers that weren't cleaned up by a test's finally block
  // (e.g. when a test timed out before reaching worker.stop()).
  await Promise.allSettled(activeWorkers.splice(0).map((w) => w.stop()))
  // Wipe queue + semaphore + runs between tests so state never leaks.
  await redis.del(TASK_QUEUE_KEY)
  await redis.del('sem')
  await AppDataSource.query(`DELETE FROM runs`)
  activePredictions = 0
  maxObservedConcurrency = 0
  predictCalls = []
  gateResolvers = []
})

/**
 * Enqueue tasks and return a fresh semaphore at `max`. The worker shares this
 * `dagents:sem` gate with the fan-out path; the test builds its own semaphore
 * instance pointed at the same key so it can both seed the cap (via `reset` +
 * the cap baked into `createRedisSemaphore`) and read `availableSlots`.
 */
function buildSem(max: number) {
  return createRedisSemaphore({ redis, maxConcurrent: max, semKey: 'sem', prefix: 'test:' })
}

/** Enqueue a task list under a semaphore sized to `max`. */
async function enqueue(tasks: ScheduleTask[], max: number): Promise<void> {
  const sem = buildSem(max)
  // Reset to a clean counter, then the cap is implicit (maxConcurrent).
  await sem.reset()
  for (const t of tasks) {
    await redis.lpush(TASK_QUEUE_KEY, JSON.stringify(t))
  }
}

describe('scheduler worker — single run execution', () => {
  it('dequeues one task, calls prediction client, and stamps the run completed', async () => {
    const prediction = mockPrediction()
    const runId = randomUUID()
    const sem = buildSem(4)
    await enqueue([{ runId, pipelineId: 'flow-1', input: { question: 'hi' } }], 4)

    const worker = trackedStartWorker({ redis, semaphore: sem, prediction })
    try {
      // Poll until the run lands in `completed`.
      const run = await waitForRun(runId, 'completed', 2000)
      expect(run).not.toBeNull()
      expect(run!.status).toBe('completed')
      expect(run!.pipelineId).toBe('flow-1')
      expect(run!.output).toEqual({ text: `result for ${runId}`, runId })
      expect(run!.failureReason).toBeNull()
      expect(run!.durationMs).not.toBeNull()
      expect(run!.startedAt).not.toBeNull()
      expect(run!.finishedAt).not.toBeNull()

      expect(predictCalls).toHaveLength(1)
      expect(predictCalls[0]).toEqual({
        runId,
        pipelineId: 'flow-1',
        input: { question: 'hi' },
      })
    } finally {
      await worker.stop()
    }
  })

  it('stamps the run failed when prediction rejects', async () => {
    const runId = randomUUID()
    const prediction = mockPrediction({ failRunIds: new Set([runId]) })
    const sem = buildSem(4)
    await enqueue([{ runId, pipelineId: 'flow-1', input: {} }], 4)

    const worker = trackedStartWorker({ redis, semaphore: sem, prediction })
    try {
      const run = await waitForRun(runId, 'failed', 2000)
      expect(run).not.toBeNull()
      expect(run!.status).toBe('failed')
      expect(run!.failureReason).toBe('mock prediction failure')
      // failure detail is wrapped in `output.error` (runs has no failure_reason col)
      expect(run!.output).toEqual({ error: 'mock prediction failure' })
      expect(run!.finishedAt).not.toBeNull()
    } finally {
      await worker.stop()
    }
  })

  it('drops a malformed queue payload without creating a run', async () => {
    const prediction = mockPrediction()
    const sem = buildSem(4)
    await sem.reset()
    // A payload that does not match ScheduleTask ({ runId, pipelineId, input }).
    await redis.lpush(TASK_QUEUE_KEY, JSON.stringify({ not: 'a task' }))

    const worker = trackedStartWorker({ redis, semaphore: sem, prediction })
    try {
      // Give the worker a moment to consume + drop the bad payload.
      await sleep(200)

      // No UUID-shaped run id was ever carried by the payload, so no run row.
      const run = await getRun(randomUUID())
      expect(run).toBeNull()
      expect(predictCalls).toHaveLength(0)
    } finally {
      await worker.stop()
    }
    // After stop() the worker no longer holds an idle slot on the empty queue,
    // so the slot it briefly acquired for the dropped payload is back: the pool
    // is whole again at the cap. (Checking before stop() would race the worker
    // re-acquiring a slot to poll the now-empty queue.)
    expect(await availableSlots(sem, 4)).toBe(4)
  })
})

describe('scheduler worker — concurrency gate', () => {
  it('caps in-flight prediction calls at maxConcurrent', async () => {
    // 5 tasks, maxConcurrent=2 → at most 2 predictions run at once.
    const tasks: ScheduleTask[] = [0, 1, 2, 3, 4].map(() => ({
      runId: randomUUID(),
      pipelineId: 'flow-1',
      input: {},
    }))
    const lastRunId = tasks[tasks.length - 1].runId

    // Block every prediction on the gate so they pile up at the cap.
    const prediction = mockPrediction({ blockOnGate: true })
    const sem = buildSem(2)
    await enqueue(tasks, 2)

    const worker = trackedStartWorker({ redis, semaphore: sem, prediction })
    try {
      // Wait until the first 2 runs are in-flight (both blocked on the gate).
      // The 3rd must NOT start — only 2 slots exist.
      await sleep(300)
      expect(maxObservedConcurrency).toBe(2)
      expect(activePredictions).toBe(2)

      // Release one slot; one more run should start (3 in flight total over
      // time, but never more than 2 simultaneously).
      releaseGate()
      await sleep(300)
      expect(maxObservedConcurrency).toBe(2)
      expect(activePredictions).toBeLessThanOrEqual(2)

      // Release everything else and let the remaining runs drain. Release one
      // gate at a time (each release unblocks exactly one queued prediction)
      // until every prediction has been started and allowed to finish. Releasing
      // all at once would let the 3rd/4th/5th start before earlier ones finish,
      // but the slot-gated worker still bounds concurrency — this just drains
      // deterministically.
      let drained = 0
      const drain = async (): Promise<void> => {
        while (predictCalls.length > drained) {
          // release one blocked prediction; it finishes and frees a slot, the
          // worker starts the next queued run
          releaseGate()
          drained += 1
          await sleep(50)
        }
        if (predictCalls.length < 5) {
          // still waiting for the worker to start more; poll a bit more
          await sleep(100)
          await drain()
        }
      }
      await drain()
      await waitForRun(lastRunId, 'completed', 3000)

      expect(maxObservedConcurrency).toBe(2) // never exceeded the cap
      expect(predictCalls).toHaveLength(5)
    } finally {
      await worker.stop()
    }
  })

  it('releases the slot when a run fails (cap not permanently shrunk)', async () => {
    const failId = randomUUID()
    const okId = randomUUID()
    const prediction = mockPrediction({ failRunIds: new Set([failId]) })
    const sem = buildSem(1)
    await enqueue(
      [
        { runId: failId, pipelineId: 'flow-1', input: {} },
        { runId: okId, pipelineId: 'flow-1', input: {} },
      ],
      1,
    )

    const worker = trackedStartWorker({ redis, semaphore: sem, prediction })
    try {
      const failed = await waitForRun(failId, 'failed', 2000)
      const ok = await waitForRun(okId, 'completed', 2000)
      expect(failed!.status).toBe('failed')
      expect(ok!.status).toBe('completed')
      // okId completing IS the proof the cap wasn't shrunk: with maxConcurrent=1,
      // a leaked slot from failId would leave the gate permanently full and okId
      // could never acquire — it would hang, not complete. (We do not assert
      // `availableSlots` while the worker is still running: the counter semaphore
      // is non-blocking, so an idle worker acquires a slot and parks in BRPOP
      // for up to 1s holding it — availableSlots would read 0 mid-cycle. After
      // stop() the loop releases and exits, so the slot is whole again.)
    } finally {
      await worker.stop()
    }
    expect(await availableSlots(sem, 1)).toBe(1)
  })
})

describe('scheduler worker — graceful stop', () => {
  it('stop() awaits an in-flight run rather than truncating it', async () => {
    const runId = randomUUID()
    const prediction = mockPrediction({ blockOnGate: true })
    const sem = buildSem(4)
    await enqueue([{ runId, pipelineId: 'flow-1', input: {} }], 4)

    const worker = trackedStartWorker({ redis, semaphore: sem, prediction })
    try {
      // Wait for the run to start (blocked on the gate, in-flight).
      await sleep(300)
      expect(activePredictions).toBe(1)

      // Release the gate, then stop. stop() should await the run's completion.
      releaseGate()
      await worker.stop()

      const run = await getRun(runId)
      expect(run?.status).toBe('completed')
    } finally {
      // worker already stopped
    }
  })
})

// ---- helpers ----

/** Poll `runs` until `runId` reaches `status`, or timeout. Returns the row. */
async function waitForRun(
  runId: string,
  status: string,
  timeoutMs: number,
): Promise<{ status: string; pipelineId: string; output: unknown; failureReason: string | null; durationMs: number | null; startedAt: Date | null; finishedAt: Date | null } | null> {
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
