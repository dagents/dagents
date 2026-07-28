import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
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
