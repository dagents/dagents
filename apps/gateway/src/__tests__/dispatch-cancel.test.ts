import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'
import {
  cancelDispatchTask,
  cancelDispatchTasksForRun,
  enqueueTask,
  getTask,
} from '../routes/dispatch/service.js'

/**
 * dispatch 任务取消协议（执行取消 spec §7 Deferred → 2026-09-06）：
 * queued/claimed 直接落终态（failed + 'cancelled'）、running 打
 * cancel_requested 由 daemon 轮询 abort、终态幂等 no-op；
 * GET /tasks/:id 透出 cancelRequested；run 级联取消。
 *
 * 种子只建 dispatch 真正的两张表：agent_daemons（enqueue 的 FK 目标，
 * 与 agents 表无关）+ runs（run_id 目标，text 引用无强制 FK）。
 */

const seededRunIds: string[] = []
const seededDaemonIds: string[] = []
const seededAgentDaemonIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (seededRunIds.length) {
    await runQuery(`DELETE FROM dispatch_tasks WHERE run_id = ANY($1::text[])`, [seededRunIds])
    await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [seededRunIds])
  }
  if (seededAgentDaemonIds.length) {
    await runQuery(`DELETE FROM agent_daemons WHERE id = ANY($1::uuid[])`, [seededAgentDaemonIds])
  }
  if (seededDaemonIds.length) {
    await runQuery(`DELETE FROM daemons WHERE id = ANY($1::uuid[])`, [seededDaemonIds])
  }
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

/** 建一对 (daemons, agent_daemons, runs) 行并返回 id。 */
async function seed(): Promise<{ agentDaemonId: string; runId: string }> {
  const runId = randomUUID()
  const daemonId = randomUUID()
  const agentDaemonId = randomUUID()
  await runQuery(`INSERT INTO daemons (id, label, token) VALUES ($1, $2, $3)`, [
    daemonId,
    `daemon-${daemonId.slice(0, 8)}`,
    `token-${daemonId.slice(0, 8)}`,
  ])
  await runQuery(
    `INSERT INTO agent_daemons (id, name, kind, daemon_id) VALUES ($1, 'cancel-test', 'claude', $2)`,
    [agentDaemonId, daemonId],
  )
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, started_at)
     VALUES ($1, $2, 'cancel-test', 'running', '{}', 'direct', NOW())`,
    [runId, runId],
  )
  seededRunIds.push(runId)
  seededDaemonIds.push(daemonId)
  seededAgentDaemonIds.push(agentDaemonId)
  return { agentDaemonId, runId }
}

describe('dispatch 取消协议', () => {
  it('queued 任务取消 → 直接终态 failed/cancelled（幂等再取消为 terminal）', async () => {
    const { agentDaemonId, runId } = await seed()
    const { taskId } = await enqueueTask({ agentDaemonId, runId, prompt: 'p' })

    const r1 = await cancelDispatchTask(taskId)
    expect(r1.outcome).toBe('terminated')
    const row = await getTask(taskId)
    expect(row!.status).toBe('failed')
    expect(row!.failureReason).toBe('cancelled')

    const r2 = await cancelDispatchTask(taskId)
    expect(r2).toMatchObject({ outcome: 'terminal', status: 'failed' })
  })

  it('running 任务取消 → 打 cancel_requested 标记（daemon 轮询发现后收尾）', async () => {
    const { agentDaemonId, runId } = await seed()
    const { taskId } = await enqueueTask({ agentDaemonId, runId, prompt: 'p' })
    await runQuery(`UPDATE dispatch_tasks SET status = 'running' WHERE id = $1`, [taskId])

    const r = await cancelDispatchTask(taskId)
    expect(r.outcome).toBe('requested')
    const row = await getTask(taskId)
    expect(row!.status).toBe('running')
    expect(row!.cancelRequested).toBe(true)

    // HTTP 面：GET 透出 cancelRequested；POST cancel 幂等
    const get = await app.request(`/api/v1/dispatch/tasks/${taskId}`)
    expect(get.status).toBe(200)
    const gj = (await get.json()) as { data?: { cancelRequested?: boolean } }
    expect(gj.data?.cancelRequested).toBe(true)
    const post = await app.request(`/api/v1/dispatch/tasks/${taskId}/cancel`, { method: 'POST' })
    expect(post.status).toBe(200)
  })

  it('cancelDispatchTasksForRun 级联取消 run 名下非终态任务', async () => {
    const { agentDaemonId, runId } = await seed()
    const a = await enqueueTask({ agentDaemonId, runId, prompt: 'a' })
    const b = await enqueueTask({ agentDaemonId, runId, prompt: 'b' })
    await runQuery(`UPDATE dispatch_tasks SET status='running' WHERE id=$1`, [b.taskId])

    const cancelled = await cancelDispatchTasksForRun(runId)
    expect(cancelled.sort()).toEqual([a.taskId, b.taskId].sort())
    expect((await getTask(a.taskId))!.status).toBe('failed')
    expect((await getTask(b.taskId))!.cancelRequested).toBe(true)
  })

  it('未知任务 → missing / HTTP 404', async () => {
    expect((await cancelDispatchTask(randomUUID())).outcome).toBe('missing')
    const res = await app.request(`/api/v1/dispatch/tasks/${randomUUID()}/cancel`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
