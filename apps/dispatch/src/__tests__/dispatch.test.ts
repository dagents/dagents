import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app, bootstrap } from '../app.js'
import { AppDataSource } from '@dagents/db'
import { randomUUID } from 'node:crypto'

/**
 * Integration tests for the dispatch protocol (M2.2).
 *
 * Drives the Hono app in-process via `app.request()` against the real dagents
 * Postgres (docker-compose stack on 127.0.0.1:15432). Each test seeds an
 * `agent_daemons` row (invoke's FK target) and cleans the dispatch tables
 * between runs so state never leaks across tests.
 *
 * Coverage:
 * - /health reports db initialized
 * - register → { daemonId, token }; heartbeat updates; deregister 404s after
 * - invoke enqueues a queued task; claim atomically pulls it (FIFO + SKIP LOCKED)
 * - second claim returns null when the queue is empty
 * - start → running; messages land in dispatch_task_events with monotonic seq
 * - complete stamps result + terminal status; double-complete 409s
 * - fail stamps failure_reason; terminal-rejection 409s
 */

let agentDaemonId: string
let daemonId: string

beforeAll(async () => {
  await bootstrap()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  // wipe dispatch state + seed a fresh agent_daemon target per test
  await AppDataSource.query(`DELETE FROM dispatch_task_events`)
  await AppDataSource.query(`DELETE FROM dispatch_tasks`)
  await AppDataSource.query(`DELETE FROM agent_daemons`)
  await AppDataSource.query(`DELETE FROM daemons`)

  const daemon = await app.request('/api/v1/dispatch/daemons/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      daemonLabel: 'test-daemon',
      capabilities: [{ agentType: 'claude', tags: ['gpu'] }],
    }),
  })
  const regBody = (await daemon.json()) as { data: { daemonId: string } }
  daemonId = regBody.data.daemonId

  const adRows = await AppDataSource.query(
    `INSERT INTO agent_daemons (name, kind, daemon_id, executable_path)
     VALUES ('claude-code', 'claude', $1, 'claude') RETURNING id`,
    [daemonId],
  )
  agentDaemonId = adRows[0].id
})

describe('dispatch /health', () => {
  it('reports ok with db initialized', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; db: boolean }
    expect(body.ok).toBe(true)
    expect(body.db).toBe(true)
  })
})

describe('daemon lifecycle', () => {
  it('register returns a daemonId and token', async () => {
    const res = await app.request('/api/v1/dispatch/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ daemonLabel: 'd2', capabilities: [] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { daemonId: string; token: string } }
    expect(body.data.daemonId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.data.token).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('heartbeat updates status and 404s for an unknown daemon', async () => {
    const ok = await app.request('/api/v1/dispatch/daemons/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ daemonId, status: 'draining', activeTasks: 0 }),
    })
    expect(ok.status).toBe(204)

    const rows = await AppDataSource.query(
      `SELECT status FROM daemons WHERE id = $1`,
      [daemonId],
    )
    expect(rows[0].status).toBe('draining')

    const missing = await app.request('/api/v1/dispatch/daemons/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        daemonId: '00000000-0000-4000-8000-000000000000',
        status: 'online',
        activeTasks: 0,
      }),
    })
    expect(missing.status).toBe(404)
  })

  it('deregister removes the daemon and 404s on repeat', async () => {
    const del = await app.request(`/api/v1/dispatch/daemons/${daemonId}`, {
      method: 'DELETE',
    })
    expect(del.status).toBe(204)
    const again = await app.request(`/api/v1/dispatch/daemons/${daemonId}`, {
      method: 'DELETE',
    })
    expect(again.status).toBe(404)
  })
})

describe('invoke + claim', () => {
  const invoke = (runId: string) =>
    app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDaemonId,
        runId,
        prompt: `hello ${runId}`,
        execOptions: { model: 'claude' },
      }),
    })

  it('invoke enqueues a queued task and claim pulls it FIFO', async () => {
    const r1 = await invoke('run-a')
    const r2 = await invoke('run-b')
    const t1 = ((await r1.json()) as { data: { taskId: string } }).data.taskId
    const t2 = ((await r2.json()) as { data: { taskId: string } }).data.taskId
    expect(t1).toMatch(/^[0-9a-f-]{36}$/)

    const queued = await AppDataSource.query(
      `SELECT status FROM dispatch_tasks WHERE id = $1`,
      [t1],
    )
    expect(queued[0].status).toBe('queued')

    const claim1 = await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, {
      method: 'POST',
    })
    const c1 = (await claim1.json()) as { data: { task: { id: string } | null } }
    expect(c1.data.task?.id).toBe(t1)

    const claim2 = await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, {
      method: 'POST',
    })
    const c2 = (await claim2.json()) as { data: { task: { id: string } | null } }
    expect(c2.data.task?.id).toBe(t2)

    const claimed = await AppDataSource.query(
      `SELECT status, claimed_by_daemon_id FROM dispatch_tasks WHERE id = $1`,
      [t1],
    )
    expect(claimed[0].status).toBe('claimed')
    expect(claimed[0].claimed_by_daemon_id).toBe(daemonId)
  })

  it('claim returns null when the queue is empty', async () => {
    const res = await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, {
      method: 'POST',
    })
    const body = (await res.json()) as { data: { task: unknown } }
    expect(body.data.task).toBeNull()
  })

  it('invoke rejects a non-uuid agentDaemonId', async () => {
    const res = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentDaemonId: 'not-a-uuid', runId: 'r', prompt: 'p' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('task lifecycle', () => {
  /** Enqueue + claim a task, returning its id. */
  async function claimTask(): Promise<string> {
    const r = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDaemonId,
        runId: randomUUID(),
        prompt: 'do work',
        execOptions: {},
      }),
    })
    const taskId = ((await r.json()) as { data: { taskId: string } }).data.taskId
    await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, {
      method: 'POST',
    })
    return taskId
  }

  it('start moves claimed → running', async () => {
    const id = await claimTask()
    const res = await app.request(`/api/v1/dispatch/tasks/${id}/start`, { method: 'POST' })
    expect(res.status).toBe(204)
    const rows = await AppDataSource.query(`SELECT status FROM dispatch_tasks WHERE id = $1`, [id])
    expect(rows[0].status).toBe('running')
  })

  it('messages land with monotonic seq across batches', async () => {
    const id = await claimTask()
    const m1 = await app.request(`/api/v1/dispatch/tasks/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }] }),
    })
    expect(m1.status).toBe(204)
    const m2 = await app.request(`/api/v1/dispatch/tasks/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ type: 'log', content: 'c' }] }),
    })
    expect(m2.status).toBe(204)

    const events = await AppDataSource.query(
      `SELECT seq FROM dispatch_task_events WHERE task_id = $1 ORDER BY seq`,
      [id],
    )
    expect(events.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3])
  })

  it('complete stamps result and terminal status; double-complete 409s', async () => {
    const id = await claimTask()
    const res = await app.request(`/api/v1/dispatch/tasks/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'done',
        sessionId: 'sess-1',
        usage: { claude: { inputTokens: 10, outputTokens: 5 } },
        durationMs: 1234,
      }),
    })
    expect(res.status).toBe(204)

    const rows = await AppDataSource.query(
      `SELECT status, session_id, duration_ms, result FROM dispatch_tasks WHERE id = $1`,
      [id],
    )
    expect(rows[0].status).toBe('completed')
    expect(rows[0].session_id).toBe('sess-1')
    expect(rows[0].duration_ms).toBe(1234)
    expect(rows[0].result.output).toBe('done')

    const dup = await app.request(`/api/v1/dispatch/tasks/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'again', usage: {}, durationMs: 1 }),
    })
    expect(dup.status).toBe(409)
  })

  it('fail stamps failure_reason and rejects complete-after-fail', async () => {
    const id = await claimTask()
    const fail = await app.request(`/api/v1/dispatch/tasks/${id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'boom', failureReason: 'timeout' }),
    })
    expect(fail.status).toBe(204)

    const rows = await AppDataSource.query(
      `SELECT status, failure_reason FROM dispatch_tasks WHERE id = $1`,
      [id],
    )
    expect(rows[0].status).toBe('failed')
    expect(rows[0].failure_reason).toBe('timeout')

    const late = await app.request(`/api/v1/dispatch/tasks/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'x', usage: {}, durationMs: 1 }),
    })
    expect(late.status).toBe(409)
  })

  it('start 404s for an unknown task', async () => {
    const res = await app.request(`/api/v1/dispatch/tasks/00000000-0000-4000-8000-000000000000/start`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /tasks/:id result lookup', () => {
  /** Enqueue + claim a task, returning its id. */
  async function claimTask(): Promise<string> {
    const r = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDaemonId,
        runId: randomUUID(),
        prompt: 'do work',
        execOptions: {},
      }),
    })
    const taskId = ((await r.json()) as { data: { taskId: string } }).data.taskId
    await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, {
      method: 'POST',
    })
    return taskId
  }

  it('404s for an unknown task id', async () => {
    const res = await app.request(`/api/v1/dispatch/tasks/00000000-0000-4000-8000-000000000000`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string; taskId: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('task not found')
    expect(body.taskId).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('returns queued/running status with null result', async () => {
    // queued: invoke without claiming
    const r = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDaemonId,
        runId: randomUUID(),
        prompt: 'queued work',
        execOptions: {},
      }),
    })
    const id = ((await r.json()) as { data: { taskId: string } }).data.taskId

    const q = await app.request(`/api/v1/dispatch/tasks/${id}`)
    expect(q.status).toBe(200)
    const qb = (await q.json()) as {
      data: { status: string; result: unknown; failureReason: string | null; finishedAt: string | null }
    }
    expect(qb.data.status).toBe('queued')
    expect(qb.data.result).toBeNull()
    expect(qb.data.failureReason).toBeNull()
    expect(qb.data.finishedAt).toBeNull()

    // running: claim this same task (it's the only queued row) then start it
    await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
    await app.request(`/api/v1/dispatch/tasks/${id}/start`, { method: 'POST' })

    const run = await app.request(`/api/v1/dispatch/tasks/${id}`)
    expect(run.status).toBe(200)
    const runb = (await run.json()) as { data: { status: string; result: unknown } }
    expect(runb.data.status).toBe('running')
    expect(runb.data.result).toBeNull()
  })

  it('returns completed status with parsed result.output', async () => {
    const id = await claimTask()
    await app.request(`/api/v1/dispatch/tasks/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        output: 'final answer',
        sessionId: 'sess-x',
        usage: { claude: { inputTokens: 7, outputTokens: 3 } },
        durationMs: 99,
      }),
    })

    const res = await app.request(`/api/v1/dispatch/tasks/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        id: string
        status: string
        result: { output: string; sessionId: string; usage: Record<string, unknown> } | null
        sessionId: string | null
        failureReason: string | null
        finishedAt: string | null
      }
    }
    expect(body.data.id).toBe(id)
    expect(body.data.status).toBe('completed')
    // result is the parsed JSONB object, not a stringified blob
    expect(body.data.result).not.toBeNull()
    expect(typeof body.data.result).toBe('object')
    expect(body.data.result!.output).toBe('final answer')
    expect(body.data.result!.sessionId).toBe('sess-x')
    expect(body.data.result!.usage.claude).toEqual({ inputTokens: 7, outputTokens: 3 })
    expect(body.data.sessionId).toBe('sess-x')
    expect(body.data.failureReason).toBeNull()
    expect(body.data.finishedAt).not.toBeNull()
  })

  it('returns failed status with failureReason', async () => {
    const id = await claimTask()
    await app.request(`/api/v1/dispatch/tasks/${id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'boom', failureReason: 'timeout' }),
    })

    const res = await app.request(`/api/v1/dispatch/tasks/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        status: string
        result: unknown
        failureReason: string | null
        finishedAt: string | null
      }
    }
    expect(body.data.status).toBe('failed')
    expect(body.data.failureReason).toBe('timeout')
    expect(body.data.finishedAt).not.toBeNull()
  })
})
