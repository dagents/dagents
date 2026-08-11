import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { parseCommand } from '../routes/chat-execute.js'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'
import { enqueueTask } from '../routes/dispatch/service.js'

// Mock the in-process dispatch service so we can assert enqueueTask calls
// without touching the dispatch_tasks table. Plan A merged dispatch into
// gateway, so routeDaemonCommand now calls enqueueTask() directly instead
// of HTTP-fetching the dispatch service.
vi.mock('../routes/dispatch/service.js', () => ({
  enqueueTask: vi.fn(),
}))

let seededChatIds: string[] = []
let seededDirIds: string[] = []
let seededAgentIds: string[] = []
let seededDaemonIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})
afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})
beforeEach(async () => {
  vi.mocked(enqueueTask).mockReset()
  await cleanup()
})
afterEach(async () => { await cleanup() })

async function cleanup(): Promise<void> {
  if (seededChatIds.length) {
    await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [seededChatIds])
    seededChatIds = []
  }
  if (seededDirIds.length) {
    await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [seededDirIds])
    seededDirIds = []
  }
  if (seededAgentIds.length) {
    await runQuery(`DELETE FROM agent_daemons WHERE id = ANY($1::uuid[])`, [seededAgentIds])
    seededAgentIds = []
  }
  if (seededDaemonIds.length) {
    await runQuery(`DELETE FROM daemons WHERE id = ANY($1::uuid[])`, [seededDaemonIds])
    seededDaemonIds = []
  }
}

async function seedDirAndChat(opts: { agentId?: string | null; flowId?: string | null } = {}): Promise<{ dirId: string; chatId: string }> {
  const dirId = randomUUID()
  await runQuery(
    `INSERT INTO directories (id, path, name, settings) VALUES ($1, $2, $3, $4)`,
    [dirId, `/test-${dirId.slice(0, 8)}`, `Dir ${dirId.slice(0, 8)}`, '{}'],
  )
  seededDirIds.push(dirId)
  const chatId = randomUUID()
  await runQuery(
    `INSERT INTO chats (id, directory_id, title, agent_id, flow_id) VALUES ($1, $2, $3, $4, $5)`,
    [chatId, dirId, 'Test Chat', opts.agentId ?? null, opts.flowId ?? null],
  )
  seededChatIds.push(chatId)
  return { dirId, chatId }
}

async function seedAgent(name?: string): Promise<string> {
  // agent_daemons.daemon_id is NOT NULL and references daemons(id), so we
  // create a minimal daemon row first, then the agent_daemon row.
  const daemonId = randomUUID()
  await runQuery(
    `INSERT INTO daemons (id, label, token) VALUES ($1, $2, $3)`,
    [daemonId, `daemon-${daemonId.slice(0, 8)}`, `token-${daemonId.slice(0, 8)}`],
  )
  seededDaemonIds.push(daemonId)

  const agentId = randomUUID()
  await runQuery(
    `INSERT INTO agent_daemons (id, name, kind, daemon_id) VALUES ($1, $2, $3, $4)`,
    [agentId, name ?? `agent-${agentId.slice(0, 8)}`, 'claude', daemonId],
  )
  seededAgentIds.push(agentId)
  return agentId
}

describe('parseCommand', () => {
  it('parses @flow <name> <message>', () => {
    const r = parseCommand('@flow my-flow do something')
    expect(r).toEqual({ kind: 'flow', target: 'my-flow', message: 'do something' })
  })

  it('parses @daemon <command>', () => {
    const r = parseCommand('@daemon status')
    expect(r).toEqual({ kind: 'daemon', target: null, message: 'status' })
  })

  it('parses @agent <name> <message>', () => {
    const r = parseCommand('@agent claude help me')
    expect(r).toEqual({ kind: 'agent', target: 'claude', message: 'help me' })
  })

  it('returns null for non-command', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  it('returns null for unknown @ command', () => {
    expect(parseCommand('@unknown foo')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull()
  })

  it('handles @flow with no message (defaults to empty)', () => {
    const r = parseCommand('@flow my-flow')
    expect(r).toEqual({ kind: 'flow', target: 'my-flow', message: '' })
  })
})

describe('POST /api/v1/chats/:id/messages — default routing', () => {
  it('writes user message and returns json mode with executing payload when chat has agentId', async () => {
    const { chatId } = await seedDirAndChat({ agentId: randomUUID(), flowId: 'flow-abc' })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello there' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { message: { id: string; role: string; content: string }; mode: string; payload?: { status?: string; runId?: string } }
    }
    expect(body.success).toBe(true)
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.content).toBe('hello there')
    // Agent path returns json mode (tokens stream via WebSocket, not SSE)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.status).toBe('executing')
    expect(body.data.payload?.runId).toBeTruthy()
  })

  it('auto-selects first agent when chat has no agentId and no flowId (auto mode)', async () => {
    // "auto" fallback: when chat has no agent binding, gateway picks the first
    // available agent from agent_daemons so the UI's "auto" selector works.
    // We seed an agent to guarantee the table is non-empty; the fallback picks
    // the oldest agent (ORDER BY created_at ASC), which may be a pre-existing
    // row from earlier test/dev data — so we assert the chat got *some*
    // agent_id, not necessarily the one we seeded.
    await seedAgent('default-agent')
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; payload?: { status?: string; runId?: string } }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.status).toBe('executing')
    expect(body.data.payload?.runId).toBeTruthy()

    // Verify the resolved agent was persisted onto the chat row so subsequent
    // messages skip the fallback lookup. The exact agent_id depends on which
    // row is oldest, so we just assert it's no longer null.
    const { records } = await runQuery<{ agent_id: string | null }>(
      `SELECT agent_id FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    expect(records[0]?.agent_id).not.toBeNull()
  })

  it('returns json mode with error when no agent is available (agent_daemons empty)', async () => {
    // Ensure no agents are available — the auto fallback should find nothing
    // in either agents or agent_daemons and return the error.
    await runQuery(`DELETE FROM agent_daemons`)
    await runQuery(`DELETE FROM agents`)
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; error?: string }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.error).toMatch(/no agent or flow bound/)
  })
})

describe('routeFlowCommand @flow wiring', () => {
  it('returns error payload when flow name not found', async () => {
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@flow nonexistent-flow do something' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        mode: string
        payload?: { ack?: string; error?: string; command?: { target?: string } }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.error).toBe('flow not found')
    expect(body.data.payload?.ack).toMatch(/Flow not found: nonexistent-flow/)
    expect(body.data.payload?.command?.target).toBe('nonexistent-flow')
  })
})

describe('routeDaemonCommand @daemon wiring', () => {
  it('returns error payload when chat has no agent_id bound', async () => {
    const { chatId } = await seedDirAndChat()

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@daemon run scan' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        mode: string
        payload?: { ack?: string; error?: string; command?: { kind?: string; message?: string } }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.error).toBe('no agent bound to chat')
    expect(body.data.payload?.ack).toMatch(/Daemon invoked: run scan/)
    expect(body.data.payload?.command?.kind).toBe('daemon')
    expect(body.data.payload?.command?.message).toBe('run scan')
  })

  it('enqueues task via in-process enqueueTask and returns runId + taskId', async () => {
    const agentId = randomUUID()
    const { chatId, dirId } = await seedDirAndChat({ agentId })
    const expectedTaskId = randomUUID()
    const expectedDirPath = `/test-${dirId.slice(0, 8)}`

    const mockEnqueue = vi.mocked(enqueueTask)
    mockEnqueue.mockResolvedValue({ taskId: expectedTaskId })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@daemon rebuild the index' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        mode: string
        payload?: {
          ack?: string
          runId?: string
          taskId?: string
          command?: { kind?: string; message?: string }
        }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.taskId).toBe(expectedTaskId)
    expect(body.data.payload?.runId).toBeTruthy()
    expect(body.data.payload?.ack).toMatch(/Daemon invoked: rebuild the index/)
    expect(body.data.payload?.command?.kind).toBe('daemon')

    // Verify enqueueTask was called with the right contract (Plan A: no HTTP).
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith({
      agentDaemonId: agentId,
      runId: body.data.payload?.runId,
      prompt: 'rebuild the index',
      execOptions: { cwd: expectedDirPath },
    })

    // Chat should be marked running.
    const { records } = await runQuery<{ status: string }>(
      `SELECT status FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    expect(records[0]?.status).toBe('running')
  })

  it('returns error payload when enqueueTask throws', async () => {
    const agentId = randomUUID()
    const { chatId } = await seedDirAndChat({ agentId })

    const mockEnqueue = vi.mocked(enqueueTask)
    mockEnqueue.mockRejectedValue(new Error('enqueue failed'))

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@daemon do thing' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { mode: string; payload?: { error?: string; ack?: string } }
    }
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.error).toMatch(/enqueue failed/)
    expect(body.data.payload?.ack).toMatch(/Daemon invoke error/)
  })
})
