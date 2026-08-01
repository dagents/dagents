import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app } from '../../app.js'
import { AppDataSource } from '@dagents/db'
import { randomUUID } from 'node:crypto'

/**
 * Integration tests for the agent catalogue read routes (M5a.2 / P1.10.T4):
 *   GET /agents            → list (agent_daemons ⋈ daemons ⋈ latest dispatch_task)
 *   GET /agents/:id        → detail (agent + recent task history + bound runs)
 *   GET /agents/:id/logs   → mapped log lines from dispatch_task_events
 *
 * Drives the Hono app in-process via `app.request()` against the real dagents
 * Postgres on 127.0.0.1:15432, matching dispatch.test.ts's setup. Each test
 * seeds a daemon + agent_daemon (+ tasks/events) and wipes state between runs.
 *
 * These routes are read-only and order-independent (they always pick the latest
 * task by created_at DESC, never rely on FIFO claim ordering), so they avoid
 * the pre-existing `created_at`-tie flakiness in the FIFO claim test.
 */

let agentDaemonId: string
let daemonId: string

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  // Wipe dispatch + daemon state and seed a fresh agent per test.
  await AppDataSource.query(`DELETE FROM dispatch_task_events`)
  await AppDataSource.query(`DELETE FROM dispatch_tasks`)
  await AppDataSource.query(`DELETE FROM agent_daemons`)
  await AppDataSource.query(`DELETE FROM daemons`)

  const reg = await app.request('/api/v1/dispatch/daemons/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      daemonLabel: 'test-daemon',
      capabilities: [{ agentType: 'claude', tags: ['gpu', 'ap-northeast'] }],
    }),
  })
  daemonId = ((await reg.json()) as { data: { daemonId: string } }).data.daemonId

  const ad = await AppDataSource.query(
    `INSERT INTO agent_daemons (name, kind, daemon_id, capability_descriptor, executable_path, visibility)
     VALUES ($1, 'claude', $2, $3, 'claude', 'private') RETURNING id`,
    [
      '论文阅读 · reader-04',
      daemonId,
      JSON.stringify({
        name: 'reader-04',
        summary: '阅读论文并抽取核心论点。',
        inputSchema: '{pdf_uri}',
        outputSchema: '{summary}',
        tags: ['reader', 'analysis'],
      }),
    ],
  )
  agentDaemonId = ad[0].id
})

/** Enqueue a task for the seeded agent at status `queued` (no claim). */
async function invoke(runId: string, prompt = 'do work'): Promise<string> {
  const r = await app.request('/api/v1/dispatch/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentDaemonId, runId, prompt, execOptions: {} }),
  })
  return ((await r.json()) as { data: { taskId: string } }).data.taskId
}

describe('GET /agents', () => {
  it('returns an empty list when no agents exist', async () => {
    await AppDataSource.query(`DELETE FROM agent_daemons`)
    const res = await app.request('/api/v1/dispatch/agents')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { agents: unknown[]; truncated: boolean } }
    expect(body.success).toBe(true)
    expect(body.data.agents).toEqual([])
    expect(body.data.truncated).toBe(false)
  })

  it('returns the agent joined with its daemon + latest task', async () => {
    await invoke('R-8821')

    const res = await app.request('/api/v1/dispatch/agents')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        agents: {
          id: string
          name: string
          kind: string
          capability_descriptor: { name: string; tags: string[] }
          daemon_label: string
          daemon_status: string
          daemon_capabilities: { agentType: string; tags: string[] }[]
          task_id: string
          run_id: string
          task_status: string
        }[]
        truncated: boolean
      }
    }
    expect(body.data.agents).toHaveLength(1)
    const a = body.data.agents[0]!
    expect(a.id).toBe(agentDaemonId)
    expect(a.name).toBe('论文阅读 · reader-04')
    expect(a.kind).toBe('claude')
    expect(a.capability_descriptor.name).toBe('reader-04')
    expect(a.capability_descriptor.tags).toEqual(['reader', 'analysis'])
    expect(a.daemon_label).toBe('test-daemon')
    expect(a.daemon_status).toBe('online')
    expect(a.daemon_capabilities[0]!.agentType).toBe('claude')
    expect(a.task_status).toBe('queued')
    expect(a.run_id).toBe('R-8821')
  })

  it('picks the latest task (newest created_at) when an agent has several', async () => {
    const older = await invoke('R-OLD')
    // Nudge the older task's created_at back so it unambiguously precedes the newer.
    await AppDataSource.query(`UPDATE dispatch_tasks SET created_at = NOW() - interval '1 hour' WHERE id = $1`, [older])
    await invoke('R-NEW')

    const res = await app.request('/api/v1/dispatch/agents')
    const body = (await res.json()) as { data: { agents: { run_id: string }[] } }
    expect(body.data.agents).toHaveLength(1)
    expect(body.data.agents[0]!.run_id).toBe('R-NEW')
  })

  it('includes an agent with no tasks (LEFT JOIN keeps it, latest task null)', async () => {
    const res = await app.request('/api/v1/dispatch/agents')
    const body = (await res.json()) as { data: { agents: { task_id: string | null; run_id: string | null }[] } }
    expect(body.data.agents).toHaveLength(1)
    expect(body.data.agents[0]!.task_id).toBeNull()
    expect(body.data.agents[0]!.run_id).toBeNull()
  })
})

describe('GET /agents/:id', () => {
  it('404s for an unknown agent id', async () => {
    const res = await app.request(`/api/v1/dispatch/agents/00000000-0000-4000-8000-000000000000`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string; agentId: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('agent not found')
  })

  it('returns the agent + recent task history (newest-first)', async () => {
    const t1 = await invoke('R-A')
    await AppDataSource.query(`UPDATE dispatch_tasks SET created_at = NOW() - interval '2 hours' WHERE id = $1`, [t1])
    const t2 = await invoke('R-B')
    await AppDataSource.query(`UPDATE dispatch_tasks SET created_at = NOW() - interval '1 hour' WHERE id = $1`, [t2])

    const res = await app.request(`/api/v1/dispatch/agents/${agentDaemonId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        agent: { id: string; name: string; capability_descriptor: { summary: string } }
        tasks: { run_id: string; status: string }[]
        runs: unknown[]
      }
    }
    expect(body.data.agent.id).toBe(agentDaemonId)
    expect(body.data.agent.capability_descriptor.summary).toBe('阅读论文并抽取核心论点。')
    expect(body.data.tasks).toHaveLength(2)
    expect(body.data.tasks.map((t) => t.run_id)).toEqual(['R-B', 'R-A']) // newest first
    // runs table is empty today (M6.2 populates it) → graceful empty array.
    expect(body.data.runs).toEqual([])
  })
})

describe('GET /agents/:id/logs', () => {
  it('404s for an unknown agent id', async () => {
    const res = await app.request(`/api/v1/dispatch/agents/00000000-0000-4000-8000-000000000000/logs`)
    expect(res.status).toBe(404)
  })

  it('returns mapped log lines for the agent’s tasks', async () => {
    const taskId = await invoke('R-8821')
    // Claim + start so we can post messages.
    await app.request(`/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, { method: 'POST' })
    await app.request(`/api/v1/dispatch/tasks/${taskId}/start`, { method: 'POST' })
    await app.request(`/api/v1/dispatch/tasks/${taskId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { type: 'status', status: 'started', sessionId: 'sess-1' },
          { type: 'text', content: 'parse arxiv 2407.1842' },
          { type: 'log', content: 'claim extraction done' },
          { type: 'error', content: 'boom' },
        ],
      }),
    })

    const res = await app.request(`/api/v1/dispatch/agents/${agentDaemonId}/logs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { logs: { ts: string; level: string; msg: string }[] } }
    // Newest-first from the SQL; the client reverses for display.
    const levels = body.data.logs.map((l) => l.level)
    expect(levels).toContain('ok') // status → ok
    expect(levels).toContain('info') // text / log → info
    expect(levels).toContain('err') // error → err
    const msgs = body.data.logs.map((l) => l.msg)
    expect(msgs).toContain('parse arxiv 2407.1842')
    expect(msgs).toContain('claim extraction done')
    expect(msgs).toContain('boom')
    // every line has an ISO timestamp
    for (const l of body.data.logs) {
      expect(l.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('returns an empty logs array for an agent with no events', async () => {
    const res = await app.request(`/api/v1/dispatch/agents/${agentDaemonId}/logs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { logs: unknown[] } }
    expect(body.data.logs).toEqual([])
  })
})

/** Sanity: the routes are mounted under /api/v1/dispatch. */
describe('mounting', () => {
  it('responds at /api/v1/dispatch/agents (not just /agents)', async () => {
    const res = await app.request('/api/v1/dispatch/agents')
    expect(res.status).toBe(200)
  })
})
