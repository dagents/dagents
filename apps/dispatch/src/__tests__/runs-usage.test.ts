import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app, bootstrap } from '../app.js'
import { AppDataSource } from '@mil/db'
import { aggregateUsage } from '../runs-usage.js'
import { randomUUID } from 'node:crypto'

/**
 * Integration tests for daemon usage 落库 (plan M6.2 / P1.11.T3).
 *
 * Drives the Hono app in-process via `app.request()` against the real
 * milagents Postgres (docker-compose stack on 127.0.0.1:15432). Each test
 * seeds a daemon + agent_daemon + a `runs` row, then exercises the
 * complete/fail → `runs.agent_daemon_calls` append + the GET /runs/:runId/usage
 * read path — the "usage 可查" acceptance gate.
 *
 * Coverage:
 * - complete appends a call with usage/duration/sessionId to the run
 * - fail appends a `failed` call (no usage)
 * - GET /runs/:runId/usage returns calls + per-model totals
 * - GET /runs/:runId/usage/by-agent rolls up per-agent
 * - invalid runId → 400; unknown runId → 404
 * - aggregateUsage (pure) sums tokens across calls + models
 *
 * `fileParallelism: false` (vitest.config.ts) — shares tables with the other
 * DB-backed dispatch files, so it must run serially.
 */

let agentDaemonId: string
let daemonId: string
let runId: string

beforeAll(async () => {
  await bootstrap()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  // wipe dispatch + runs state, then seed a daemon / agent_daemon / run row
  await AppDataSource.query(`DELETE FROM dispatch_task_events`)
  await AppDataSource.query(`DELETE FROM dispatch_tasks`)
  await AppDataSource.query(`DELETE FROM runs`)
  await AppDataSource.query(`DELETE FROM agent_daemons`)
  await AppDataSource.query(`DELETE FROM daemons`)

  const daemon = await app.request('/api/v1/dispatch/daemons/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      daemonLabel: 'usage-daemon',
      capabilities: [{ agentType: 'claude', tags: ['gpu'] }],
    }),
  })
  daemonId = ((await daemon.json()) as { data: { daemonId: string } }).data.daemonId

  const adRows = await AppDataSource.query(
    `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path)
     VALUES ('claude-code', 'claude', $1, 'claude') RETURNING id`,
    [daemonId],
  )
  agentDaemonId = adRows[0].id

  // The owning run. `runs.id` is UUID; dispatch_tasks.run_id is TEXT-shaped to it.
  runId = randomUUID()
  await AppDataSource.query(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input)
     VALUES ($1, $2, 'flow-1', 'running', '{}'::jsonb)`,
    [runId, runId],
  )
})

/** Enqueue + claim + start a task tied to the seeded run, returning its id. */
async function claimStartedTask(): Promise<string> {
  const r = await app.request('/api/v1/dispatch/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentDaemonId, runId, prompt: 'do work', execOptions: {} }),
  })
  const taskId = ((await r.json()) as { data: { taskId: string } }).data.taskId
  await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
  await app.request(`/api/v1/dispatch/tasks/${taskId}/start`, { method: 'POST' })
  return taskId
}

describe('complete / fail → runs.agent_daemon_calls', () => {
  it('complete appends a call with usage + duration + sessionId to the run', async () => {
    const taskId = await claimStartedTask()
    const res = await app.request(`/api/v1/dispatch/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'done',
        sessionId: 'sess-1',
        usage: {
          claude: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
          'claude-haiku': { inputTokens: 100, outputTokens: 50 },
        },
        durationMs: 1234,
      }),
    })
    expect(res.status).toBe(204)

    const rows = await AppDataSource.query(
      `SELECT agent_daemon_calls FROM runs WHERE id = $1`,
      [runId],
    )
    const calls = rows[0].agent_daemon_calls
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      agentDaemonId,
      dispatchTaskId: taskId,
      status: 'completed',
      usage: {
        claude: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
        'claude-haiku': { inputTokens: 100, outputTokens: 50 },
      },
      durationMs: 1234,
      sessionId: 'sess-1',
    })
    expect(typeof calls[0].finishedAt).toBe('string')
  })

  it('fail appends a failed call (no usage) to the run', async () => {
    const taskId = await claimStartedTask()
    const res = await app.request(`/api/v1/dispatch/tasks/${taskId}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'boom', failureReason: 'timeout', sessionId: 'sess-2' }),
    })
    expect(res.status).toBe(204)

    const rows = await AppDataSource.query(
      `SELECT agent_daemon_calls FROM runs WHERE id = $1`,
      [runId],
    )
    const calls = rows[0].agent_daemon_calls
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      agentDaemonId,
      dispatchTaskId: taskId,
      status: 'failed',
      sessionId: 'sess-2',
    })
    expect(calls[0].usage).toBeUndefined()
  })

  it('multiple complete calls on the same run accumulate (no clobber)', async () => {
    const t1 = await claimStartedTask()
    await app.request(`/api/v1/dispatch/tasks/${t1}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'one',
        usage: { claude: { inputTokens: 10, outputTokens: 5 } },
        durationMs: 100,
      }),
    })
    const t2 = await claimStartedTask()
    await app.request(`/api/v1/dispatch/tasks/${t2}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'two',
        usage: { claude: { inputTokens: 20, outputTokens: 15 } },
        durationMs: 200,
      }),
    })

    const rows = await AppDataSource.query(
      `SELECT agent_daemon_calls FROM runs WHERE id = $1`,
      [runId],
    )
    expect(rows[0].agent_daemon_calls).toHaveLength(2)
  })

  it('a task whose run_id has no runs row still completes (best-effort append)', async () => {
    // Enqueue against a non-existent run id; the task itself must still settle.
    const r = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDaemonId,
        runId: randomUUID(),
        prompt: 'orphan',
        execOptions: {},
      }),
    })
    const taskId = ((await r.json()) as { data: { taskId: string } }).data.taskId
    await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
    await app.request(`/api/v1/dispatch/tasks/${taskId}/start`, { method: 'POST' })
    const res = await app.request(`/api/v1/dispatch/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'ok',
        usage: { claude: { inputTokens: 1, outputTokens: 1 } },
        durationMs: 1,
      }),
    })
    expect(res.status).toBe(204)

    const taskRows = await AppDataSource.query(
      `SELECT status FROM dispatch_tasks WHERE id = $1`,
      [taskId],
    )
    expect(taskRows[0].status).toBe('completed')
  })
})

describe('GET /runs/:runId/usage', () => {
  it('returns the call log + per-model totals after a complete', async () => {
    const taskId = await claimStartedTask()
    await app.request(`/api/v1/dispatch/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'done',
        sessionId: 'sess-1',
        usage: {
          claude: { inputTokens: 10, outputTokens: 5 },
          'claude-haiku': { inputTokens: 100, outputTokens: 50 },
        },
        durationMs: 1234,
      }),
    })

    const res = await app.request(`/api/v1/dispatch/runs/${runId}/usage`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        run: { id: string; status: string; cost: string }
        calls: Array<{ status: string; usage: Record<string, unknown> }>
        totals: {
          byModel: Record<string, { inputTokens: number; outputTokens: number; calls: number }>
          totalCalls: number
        }
      }
    }
    expect(body.data.run.id).toBe(runId)
    expect(body.data.calls).toHaveLength(1)
    expect(body.data.calls[0].status).toBe('completed')
    expect(body.data.totals.totalCalls).toBe(1)
    expect(body.data.totals.byModel.claude).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 1,
    })
    expect(body.data.totals.byModel['claude-haiku'].inputTokens).toBe(100)
  })

  it('returns an empty calls array + {} totals for a run with no calls', async () => {
    const res = await app.request(`/api/v1/dispatch/runs/${runId}/usage`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { calls: unknown[]; totals: { byModel: Record<string, unknown>; totalCalls: number } }
    }
    expect(body.data.calls).toEqual([])
    expect(body.data.totals.byModel).toEqual({})
    expect(body.data.totals.totalCalls).toBe(0)
  })

  it('400s on an invalid runId', async () => {
    const res = await app.request('/api/v1/dispatch/runs/not-a-uuid/usage')
    expect(res.status).toBe(400)
  })

  it('404s on an unknown runId', async () => {
    const res = await app.request(
      `/api/v1/dispatch/runs/00000000-0000-4000-8000-000000000000/usage`,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /runs/:runId/usage/by-agent', () => {
  it('rolls up calls per agent', async () => {
    const t1 = await claimStartedTask()
    await app.request(`/api/v1/dispatch/tasks/${t1}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'one',
        usage: { claude: { inputTokens: 10, outputTokens: 5 } },
        durationMs: 100,
      }),
    })
    const t2 = await claimStartedTask()
    await app.request(`/api/v1/dispatch/tasks/${t2}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'two',
        usage: { claude: { inputTokens: 20, outputTokens: 15 } },
        durationMs: 200,
      }),
    })

    const res = await app.request(`/api/v1/dispatch/runs/${runId}/usage/by-agent`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { byAgent: Array<{ agentDaemonId: string | null; calls: number; totalDurationMs: number | null }> }
    }
    expect(body.data.byAgent).toHaveLength(1)
    expect(body.data.byAgent[0]).toMatchObject({
      agentDaemonId,
      calls: 2,
      totalDurationMs: 300,
    })
  })

  it('404s on an unknown runId', async () => {
    const res = await app.request(
      `/api/v1/dispatch/runs/00000000-0000-4000-8000-000000000000/usage/by-agent`,
    )
    expect(res.status).toBe(404)
  })

  it('400s on an invalid runId', async () => {
    const res = await app.request('/api/v1/dispatch/runs/not-a-uuid/usage/by-agent')
    expect(res.status).toBe(400)
  })
})

describe('aggregateUsage (pure)', () => {
  it('sums tokens across calls and models, counting calls per model', () => {
    const { byModel, totalCalls } = aggregateUsage([
      { usage: { claude: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } } },
      { usage: { claude: { inputTokens: 20, outputTokens: 15 }, 'claude-haiku': { inputTokens: 100 } } },
      { usage: undefined }, // a failed call with no usage — counts toward totalCalls only
    ])
    expect(totalCalls).toBe(3)
    expect(byModel.claude).toEqual({
      inputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      calls: 2,
    })
    expect(byModel['claude-haiku'].inputTokens).toBe(100)
    expect(byModel['claude-haiku'].calls).toBe(1)
  })

  it('ignores non-object usage entries', () => {
    const { byModel, totalCalls } = aggregateUsage([
      { usage: { claude: 'not-an-object' } },
      { usage: { bad: null } },
    ])
    expect(totalCalls).toBe(2)
    expect(byModel).toEqual({})
  })
})
