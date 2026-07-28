import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { parseCommand } from '../routes/chat-execute.js'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

let seededChatIds: string[] = []
let seededDirIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})
afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})
beforeEach(async () => { await cleanup() })
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
  it('writes user message and returns stream mode when chat has agentId', async () => {
    const { chatId } = await seedDirAndChat({ agentId: randomUUID(), flowId: 'flow-abc' })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello there' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { message: { id: string; role: string; content: string }; mode: string; chatRunId?: string }
    }
    expect(body.success).toBe(true)
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.content).toBe('hello there')
    expect(body.data.mode).toBe('stream')
    expect(body.data.chatRunId).toBeTruthy()
  })

  it('returns json mode with error when chat has no agentId and no flowId', async () => {
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

  it('enqueues task on dispatch /invoke and returns runId + taskId', async () => {
    const agentId = randomUUID()
    const { chatId, dirId } = await seedDirAndChat({ agentId })
    const expectedTaskId = randomUUID()
    const expectedDirPath = `/test-${dirId.slice(0, 8)}`

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { taskId: expectedTaskId } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    try {
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

      // Verify dispatch was called with the right URL + body contract.
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const fetchUrl = mockFetch.mock.calls[0][0] as string
      const fetchOpts = mockFetch.mock.calls[0][1] as {
        method: string
        headers: Record<string, string>
        body: string
      }
      expect(fetchUrl).toBe('http://localhost:8081/api/v1/dispatch/invoke')
      expect(fetchOpts.method).toBe('POST')
      expect(fetchOpts.headers['content-type']).toBe('application/json')
      const dispatched = JSON.parse(fetchOpts.body) as {
        agentDaemonId: string
        runId: string
        prompt: string
        execOptions: { cwd?: string }
      }
      expect(dispatched.agentDaemonId).toBe(agentId)
      expect(dispatched.runId).toBe(body.data.payload?.runId)
      expect(dispatched.prompt).toBe('rebuild the index')
      expect(dispatched.execOptions.cwd).toBe(expectedDirPath)

      // Chat should be marked running.
      const { records } = await runQuery<{ status: string }>(
        `SELECT status FROM chats WHERE id = $1::uuid`,
        [chatId],
      )
      expect(records[0]?.status).toBe('running')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns error payload when dispatch returns non-ok status', async () => {
    const agentId = randomUUID()
    const { chatId } = await seedDirAndChat({ agentId })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('enqueue failed'),
    })
    vi.stubGlobal('fetch', mockFetch)

    try {
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
      expect(body.data.payload?.error).toBe('dispatch invoke failed')
      expect(body.data.payload?.ack).toMatch(/Daemon invoke failed: 422/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
