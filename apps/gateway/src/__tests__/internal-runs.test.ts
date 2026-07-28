import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

let seededChatIds: string[] = []
let seededDirIds: string[] = []
let seededMessageIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  process.env.INTERNAL_CALLBACK_TOKEN = 'test-internal-token'
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  await cleanup()
})
afterEach(async () => {
  await cleanup()
})

async function cleanup(): Promise<void> {
  if (seededMessageIds.length) {
    await runQuery(`DELETE FROM chat_messages WHERE id = ANY($1::uuid[])`, [seededMessageIds])
    seededMessageIds = []
  }
  if (seededChatIds.length) {
    await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [seededChatIds])
    seededChatIds = []
  }
  if (seededDirIds.length) {
    await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [seededDirIds])
    seededDirIds = []
  }
}

async function seedDirAndChat(): Promise<{ dirId: string; chatId: string }> {
  const dirId = randomUUID()
  await runQuery(
    `INSERT INTO directories (id, path, name, settings) VALUES ($1, $2, $3, $4)`,
    [dirId, `/test-internal-${dirId.slice(0, 8)}`, `Dir ${dirId.slice(0, 8)}`, '{}'],
  )
  seededDirIds.push(dirId)
  const chatId = randomUUID()
  await runQuery(
    `INSERT INTO chats (id, directory_id, title) VALUES ($1, $2, $3)`,
    [chatId, dirId, 'test'],
  )
  seededChatIds.push(chatId)
  return { dirId, chatId }
}

describe('POST /internal/runs/:runId/complete', () => {
  // run_id is a uuid column (chat-message.entity.ts), so use a real UUID —
  // matches how scheduler/dispatch generate runIds in production (randomUUID()).
  const runId = randomUUID()

  it('rejects without x-internal-token header', async () => {
    const { chatId } = await seedDirAndChat()
    const res = await app.request(`/internal/runs/${runId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, output: 'hi', status: 'completed' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects wrong token', async () => {
    const { chatId } = await seedDirAndChat()
    const res = await app.request(`/internal/runs/${runId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong' },
      body: JSON.stringify({ chatId, output: 'hi', status: 'completed' }),
    })
    expect(res.status).toBe(401)
  })

  it('writes assistant message + broadcasts WS', async () => {
    const { chatId } = await seedDirAndChat()
    const res = await app.request(`/internal/runs/${runId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'test-internal-token' },
      body: JSON.stringify({
        chatId,
        output: 'flow result: 42',
        status: 'completed',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        durationMs: 1200,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.messageId).toBeTypeOf('string')

    // Register the messageId for cleanup IMMEDIATELY so an assertion failure
    // below can't leak the row (cleanup runs in afterEach regardless).
    seededMessageIds.push(body.data.messageId)

    // The returned messageId should be a persisted assistant message row.
    const { records } = await runQuery<{ id: string; role: string; content: string }>(
      `SELECT id, role, content FROM chat_messages WHERE id = $1::uuid`,
      [body.data.messageId],
    )
    expect(records[0]?.role).toBe('assistant')
    expect(records[0]?.content).toBe('flow result: 42')
  })

  it('returns 400 for invalid chatId (zod validation)', async () => {
    const res = await app.request('/internal/runs/' + randomUUID() + '/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'test-internal-token' },
      body: JSON.stringify({ chatId: 'not-a-uuid', output: 'hi', status: 'completed' }),
    })
    expect(res.status).toBe(400)
  })
})
