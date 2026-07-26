import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { createRedis } from '@dagents/shared'
import type { RedisClient } from '@dagents/shared'
import { recoverStaleRuns } from '../recovery.js'
import { createRedisSemaphore, availableSlots } from '../semaphore.js'
import { TASK_QUEUE_KEY } from '../queue.js'
import { startWorker } from '../worker.js'
import { fanOut } from '../fanout.js'
import {
  completeRun,
  createRun,
  getRun,
  listChildren,
  markRunning,
} from '../runs-repo.js'
import type { PredictionClient, PredictionRequest, PredictionResult } from '../prediction-client.js'

/**
 * M3.6 批量端到端 (plan §Task M3.6 / spec §M3 验收 "批量任务可跑可查, 重启可续").
 *
 * Acceptance (issue description): "N 篇输入 → fan-out → 中途重启 → 续跑完成."
 *
 * This is the integration capstone for milestone M3: it wires the three
 * milestone pieces together against the real dagents Postgres (`runs`) +
 * Redis (`dagents:tasks`, `dagents:sem`) docker-compose stack —
 *
 * - M3.2 fan-out (parent + N children, shared `dagents:sem` gate)
 * - M3.4 rerun (not exercised here; covered by rerun.test.ts)
 * - M3.5 restart recovery (`recoverStaleRuns` zeroes leaked slots + re-enqueues
 *   `running` rows)
 *
 * — and asserts the *batch* contract across a crash: after the scheduler is
 * killed mid-batch, a restart must (a) leave already-completed children alone,
 * (b) resume the children that were mid-prediction, and (c) close the parent
 * run with the correct aggregate so the batch is queryable as "done".
 *
 * The crash state is seeded via the real `runs`-repo functions (createRun /
 * markRunning / completeRun) rather than raw SQL, so the post-crash rows are
 * exactly what a killed `fanOut` would have left: a `pending` parent, some
 * `completed` children, some `running` children, and `dagents:sem` short by the
 * in-flight count. `recoverStaleRuns` + a fresh `startWorker` then play the
 * role of the restarted process. (Same seeding rationale as recovery.test.ts:
 * the only faithful way to freeze a "running mid-prediction" row is to seed it
 * — a live in-process prediction can't be frozen without killing the process.)
 *
 * The default URL bakes in the dev Redis password — see fanout.test.ts for the
 * NOAUTH rationale. Override via REDIS_URL for a non-dev stack.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:16479'
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

/**
 * Stub prediction client: records every call (runId + body) and returns a
 * canned output echoing the body. `slowFor` adds a delay so concurrency is
 * observable without a gate.
 */
function stubPrediction(log: { calls: PredictionRequest[] }): PredictionClient {
  return {
    predict: async (req: PredictionRequest, runId: string): Promise<PredictionResult> => {
      log.calls.push(req)
      await sleep(5)
      return { runId, output: { ok: true, echoed: req.body, runId }, durationMs: 6 }
    },
  }
}

describe('M3.6 — happy path: N 篇 → fan-out → 全部完成 + parent 聚合', () => {
  it('runs a 5-child batch to completion and aggregates the parent', async () => {
    const calls: PredictionRequest[] = []
    const sem = createRedisSemaphore({ redis, maxConcurrent: 5, semKey: 'sem' })
    const result = await fanOut(
      {
        flowId: 'flow-batch',
        pipelineId: 'flow-batch',
        identifier: 'm3.6-happy',
        inputs: Array.from({ length: 5 }, (_, i) => ({ body: { paper: i } })),
      },
      { prediction: stubPrediction({ calls }), semaphore: sem },
    )

    // N children predicted, parent aggregated
    expect(result.total).toBe(5)
    expect(result.completed).toBe(5)
    expect(result.failed).toBe(0)
    expect(calls).toHaveLength(5)
    expect(result.aggregate.total).toBe(5)
    expect(result.aggregate.completed).toBe(5)

    // parent row is closed with the aggregate
    const parent = await getRun(result.parentRunId)
    expect(parent?.status).toBe('completed')
  })
})

describe('M3.6 — 中途重启 → 续跑完成 (the acceptance case)', () => {
  /**
   * Seed the exact post-crash state of a partially-run batch:
   * - 1 parent (pending — fanOut was killed before completeParentRun)
   * - `doneCount` children already completed (these finished before the crash)
   * - `runningCount` children still `running` (mid-prediction when SIGKILL hit)
   * - `dagents:sem` short by `runningCount` (each in-flight child held a leaked slot)
   *
   * Uses the real repo functions so the rows match what a killed `fanOut`
   * leaves behind. `flowId == pipelineId` (the realistic shape: the fan-out
   * caller's pipeline_id is the Flowise flow id — see queue.ts).
   */
  async function seedPartialBatch(opts: {
    flowId: string
    identifier: string
    total: number
    doneCount: number
    sem: ReturnType<typeof createRedisSemaphore>
  }): Promise<{ parentId: string; doneIds: string[]; runningIds: string[] }> {
    const { flowId, identifier, total, doneCount, sem } = opts

    // parent (pending) — input is the whole batch, as fanOut writes it
    const parent = await createRun({
      identifier,
      pipelineId: flowId,
      parentRunId: null,
      input: {
        flowId,
        inputs: Array.from({ length: total }, (_, i) => ({ body: { paper: i } })),
      },
    })

    const doneIds: string[] = []
    const runningIds: string[] = []
    for (let i = 0; i < total; i++) {
      const child = await createRun({
        identifier: `${identifier}#${i + 1}`,
        pipelineId: flowId,
        parentRunId: parent.id,
        input: { paper: i },
      })
      // every child had at least reached `running` (markRunning) before the crash
      await markRunning(child.id)
      if (i < doneCount) {
        // these finished before the crash
        await completeRun(child.id, {
          output: { ok: true, paper: i, phase: 'pre-crash' },
          durationMs: 10,
        })
        doneIds.push(child.id)
      } else {
        // these were mid-prediction: leaked slot, row left `running`
        expect((await sem.acquire()).acquired).toBe(true)
        runningIds.push(child.id)
      }
    }

    // sanity: the crash state is what we intended
    expect(await sem.count()).toBe(runningIds.length)
    const stale = await listStaleRunsToCheck()
    expect(stale.length).toBe(runningIds.length)

    return { parentId: parent.id, doneIds, runningIds }
  }

  /** Temporary local listStaleRuns check for the seed sanity assertion. */
  async function listStaleRunsToCheck(): Promise<{ id: string }[]> {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM runs WHERE status = 'running'`,
    )
    return records
  }

  it('resumes the running children, leaves completed children untouched, and aggregates the parent', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 3, semKey: 'sem' })
    const { parentId, doneIds, runningIds } = await seedPartialBatch({
      flowId: 'flow-batch',
      identifier: 'm3.6-crash',
      total: 5,
      doneCount: 2,
      sem,
    })
    expect(runningIds).toHaveLength(3)

    // --- "restart" ---
    const recovered = await recoverStaleRuns({ redis, semaphore: sem })
    expect(recovered.recovered).toBe(3)
    expect(recovered.runIds.sort()).toEqual(runningIds.slice().sort())
    expect(await sem.count()).toBe(0) // leaked slots cleared
    // boot sweep did NOT close this parent: 3 children were still `running` at
    // boot (re-enqueued above), so the batch is not settled — the worker hook
    // closes it once the last recovered child settles.
    expect(recovered.closedParents).toEqual([])

    // worker drains the recovered queue. The stub records which runs it predicted.
    const calls: PredictionRequest[] = []
    const worker = startWorker({
      redis,
      semaphore: sem,
      prediction: stubPrediction({ calls }),
    })
    try {
      // wait for the 3 recovered children to complete
      for (const id of runningIds) {
        const run = await waitForRun(id, 'completed', 3000)
        expect(run).not.toBeNull()
        expect(run!.status).toBe('completed')
      }
    } finally {
      await worker.stop()
    }

    // ONLY the 3 running children were re-predicted; the 2 pre-crash-completed
    // children were NOT re-run (recovery re-enqueues running rows only).
    expect(calls).toHaveLength(3)
    const predictedBodies = calls.map((c) => (c.body as { paper: number }).paper).sort()
    expect(predictedBodies).toEqual([2, 3, 4])

    // the pre-crash completed children are untouched (still completed, original output)
    for (const id of doneIds) {
      const run = await getRun(id)
      expect(run?.status).toBe('completed')
      expect(run?.output).toMatchObject({ phase: 'pre-crash' })
    }

    // full budget restored after the worker stops
    expect(await availableSlots(sem, 3)).toBe(3)

    // --- the gap is now closed: parent was aggregated by the worker hook
    // after the last recovered child settled (the batch's own fanOut was killed
    // before its completeParentRun). The batch is queryable as "done". ---
    const parent = await getRun(parentId)
    expect(parent?.status).toBe('completed')
    const parentOutput = parent?.output as {
      total: number
      completed: number
      failed: number
      children: Array<{ status: string }>
    }
    expect(parentOutput.total).toBe(5)
    expect(parentOutput.completed).toBe(5)
    expect(parentOutput.failed).toBe(0)
  })

  it('seeded crash state is internally consistent (no leaked slots, all running rows recovered)', async () => {
    // This is the contract of the *crash state*, independent of any fix. It
    // pins what a killed-mid-batch fanOut leaves behind and what restart
    // recovery already guarantees — the per-child resume that M3.5 ships today.
    const sem = createRedisSemaphore({ redis, maxConcurrent: 3, semKey: 'sem' })
    const { parentId, runningIds } = await seedPartialBatch({
      flowId: 'flow-batch',
      identifier: 'm3.6-contract',
      total: 5,
      doneCount: 2,
      sem,
    })

    // restart: recover + drain
    await recoverStaleRuns({ redis, semaphore: sem })
    expect(await sem.count()).toBe(0) // leaked slots cleared
    const worker = startWorker({
      redis,
      semaphore: sem,
      prediction: stubPrediction({ calls: [] }),
    })
    try {
      for (const id of runningIds) {
        await waitForRun(id, 'completed', 3000)
      }
    } finally {
      await worker.stop()
    }

    // every child is now terminal — the batch *ran* to completion end-to-end
    const children = await listChildren(parentId)
    expect(children).toHaveLength(5)
    expect(children.every((c) => c.status === 'completed')).toBe(true)
    expect(await availableSlots(sem, 3)).toBe(3)

    // and the parent is aggregated (worker hook closed it after the last
    // recovered child settled) — "续跑完成" now holds at the batch level too.
    const parent = await getRun(parentId)
    expect(parent?.status).toBe('completed')
  })

  it('closes a parent left pending by a mid-batch crash once all children are terminal (the gap fixed)', async () => {
    // FIXED BEHAVIOR (M3.6). Previously (main@ca5b574) this was a pinned
    // regression: restart recovery re-enqueued the running *child* rows and the
    // worker re-ran each to terminal — so all N children completed — but the
    // *parent* run, which fanOut closes via completeParentRun AFTER every child
    // settles, was killed before that close ran. Nothing on the restart path
    // re-aggregated it, so the parent stayed 'pending' even though every child
    // was terminal: "续跑完成" per-child but NOT "完成" per-batch.
    //
    // The fix (M3.6) adds the batch-level close loop: recoverStaleRuns closes
    // parents whose children were all terminal at boot (boot sweep), and the
    // worker closes a parent via closeParentIfSettled after each recovered child
    // settles (worker hook). This case — children still `running` at boot,
    // drained by the worker — is the worker-hook arm: the parent flips from
    // 'pending' to 'completed' once the last recovered child settles.
    const sem = createRedisSemaphore({ redis, maxConcurrent: 3, semKey: 'sem' })
    const { parentId, runningIds } = await seedPartialBatch({
      flowId: 'flow-batch',
      identifier: 'm3.6-gap',
      total: 5,
      doneCount: 2,
      sem,
    })

    await recoverStaleRuns({ redis, semaphore: sem })
    const worker = startWorker({
      redis,
      semaphore: sem,
      prediction: stubPrediction({ calls: [] }),
    })
    try {
      for (const id of runningIds) {
        await waitForRun(id, 'completed', 3000)
      }
    } finally {
      await worker.stop()
    }

    const children = await listChildren(parentId)
    expect(children.every((c) => c.status === 'completed')).toBe(true)

    // ← the gap, now closed: parent IS aggregated, not left pending.
    const parent = await getRun(parentId)
    expect(parent?.status).toBe('completed')
    const parentOutput = parent?.output as {
      total: number
      completed: number
      failed: number
    }
    expect(parentOutput.total).toBe(5)
    expect(parentOutput.completed).toBe(5)
    expect(parentOutput.failed).toBe(0)
  })

  it('boot sweep closes a parent whose children were all terminal at restart (crash landed before the parent close call)', async () => {
    // The other crash shape: the crash happened AFTER every child had settled
    // but BEFORE fanOut's completeParentRun ran. There is nothing `running` to
    // re-enqueue — recoverStaleRuns's scan is empty — so the worker hook never
    // fires. The boot sweep (listSettledPendingParents → completeParentRun) is
    // the only arm that can close such a parent, entirely inside recoverStaleRuns.
    const sem = createRedisSemaphore({ redis, maxConcurrent: 3, semKey: 'sem' })
    const { parentId } = await seedPartialBatch({
      flowId: 'flow-batch',
      identifier: 'm3.6-sweep',
      total: 4,
      doneCount: 4, // every child already terminal at boot; nothing running
      sem,
    })

    // No worker is started — there is nothing to drain. The close must happen
    // entirely within recoverStaleRuns's boot sweep.
    const recovered = await recoverStaleRuns({ redis, semaphore: sem })
    expect(recovered.recovered).toBe(0) // no running rows to re-enqueue
    expect(recovered.closedParents).toEqual([parentId])

    const parent = await getRun(parentId)
    expect(parent?.status).toBe('completed')
    const parentOutput = parent?.output as { total: number; completed: number }
    expect(parentOutput.total).toBe(4)
    expect(parentOutput.completed).toBe(4)
  })

  it('resumes a fully-in-flight batch (all N children running, none pre-crash-completed)', async () => {
    const sem = createRedisSemaphore({ redis, maxConcurrent: 4, semKey: 'sem' })
    const { parentId, runningIds } = await seedPartialBatch({
      flowId: 'flow-batch',
      identifier: 'm3.6-allrunning',
      total: 4,
      doneCount: 0,
      sem,
    })
    expect(runningIds).toHaveLength(4)

    const recovered = await recoverStaleRuns({ redis, semaphore: sem })
    expect(recovered.recovered).toBe(4)

    let peak = 0
    let active = 0
    const gated: PredictionClient = {
      predict: async (req, runId) => {
        active += 1
        peak = Math.max(peak, active)
        await sleep(20)
        active -= 1
        return { runId, output: { ok: true, echoed: req.body }, durationMs: 21 }
      },
    }
    const worker = startWorker({ redis, semaphore: sem, prediction: gated })
    try {
      for (const id of runningIds) {
        await waitForRun(id, 'completed', 4000)
      }
    } finally {
      await worker.stop()
    }

    // 4 recovered runs under a gate of 4 → concurrency never exceeded the cap
    expect(peak).toBeLessThanOrEqual(4)

    // all children terminal (the batch ran to completion end-to-end)
    const children = await listChildren(parentId)
    expect(children.every((c) => c.status === 'completed')).toBe(true)
    expect(await availableSlots(sem, 4)).toBe(4)

    // parent aggregated by the worker hook (all 4 recovered children settled)
    const parent = await getRun(parentId)
    expect(parent?.status).toBe('completed')
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

// `randomUUID` is imported for callers that want to mint ids outside the
// DB-default path; referenced here to keep the import used if helpers expand.
void randomUUID