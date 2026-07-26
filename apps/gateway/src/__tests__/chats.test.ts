import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

let seededMessageIds: string[] = []
let seededChatIds: string[] = []
let seededDirectoryIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  await cleanupSeeded()
})

afterEach(async () => {
  await cleanupSeeded()
})

async function cleanupSeeded(): Promise<void> {
  if (seededMessageIds.length > 0) {
    await runQuery(`DELETE FROM chat_messages WHERE id = ANY($1::uuid[])`, [
      seededMessageIds,
    ])
    seededMessageIds = []
  }
  if (seededChatIds.length > 0) {
    await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [
      seededChatIds,
    ])
    seededChatIds = []
  }
  if (seededDirectoryIds.length > 0) {
    await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [
      seededDirectoryIds,
    ])
    seededDirectoryIds = []
  }
}

interface SeedDirectoryOpts {
  path?: string
  name?: string
  settings?: unknown
}

async function seedDirectory(opts: SeedDirectoryOpts = {}): Promise<string> {
  const id = randomUUID()
  const path = opts.path ?? `/dir-${id.slice(0, 8)}`
  const name = opts.name ?? `Dir ${id.slice(0, 8)}`
  await runQuery(
    `INSERT INTO directories (id, path, name, settings)
     VALUES ($1, $2, $3, $4)`,
    [
      id,
      path,
      name,
      JSON.stringify(opts.settings ?? {}),
    ],
  )
  seededDirectoryIds.push(id)
  return id
}

interface SeedChatOpts {
  title?: string
  status?: string
}

async function seedChat(directoryId: string, opts: SeedChatOpts = {}): Promise<string> {
  const id = randomUUID()
  const title = opts.title ?? `Chat ${id.slice(0, 8)}`
  const status = opts.status ?? 'idle'
  await runQuery(
    `INSERT INTO chats (id, directory_id, title, status)
     VALUES ($1, $2, $3, $4)`,
    [id, directoryId, title, status],
  )
  seededChatIds.push(id)
  return id
}

interface SeedMessageOpts {
  role?: string
  content?: string
  runId?: string
  metadata?: unknown
}

async function seedMessage(chatId: string, opts: SeedMessageOpts = {}): Promise<string> {
  const id = randomUUID()
  const role = opts.role ?? 'user'
  const content = opts.content ?? `Message ${id.slice(0, 8)}`
  const runId = opts.runId ?? null
  const metadata = opts.metadata ?? {}
  await runQuery(
    `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, chatId, role, content, runId, JSON.stringify(metadata)],
  )
  seededMessageIds.push(id)
  return id
}

describe('GET /api/v1/chats — list by directory', () => {
  it('returns chats for a directory sorted by updated_at desc', async () => {
    const dirId = await seedDirectory()
    const t0 = new Date('2026-07-08T10:00:00.000Z')
    const t1 = new Date('2026-07-09T10:00:00.000Z')
    const a = await seedChat(dirId, { title: 'Old Chat' })
    const b = await seedChat(dirId, { title: 'New Chat' })

    await runQuery(`UPDATE chats SET updated_at = $1 WHERE id = $2`, [t0, a])
    await runQuery(`UPDATE chats SET updated_at = $1 WHERE id = $2`, [t1, b])

    const res = await app.request(`/api/v1/chats?directory_id=${dirId}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: Array<{ id: string; title: string }> } }
    expect(body.success).toBe(true)
    const items = body.data.items
    expect(items.length).toBe(2)
    const bIdx = items.findIndex((i) => i.id === b)
    const aIdx = items.findIndex((i) => i.id === a)
    expect(bIdx).toBeLessThan(aIdx)
  })

  it('requires directory_id query param (400 if missing)', async () => {
    const res = await app.request('/api/v1/chats', { method: 'GET' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/chats/:id — detail', () => {
  it('returns chat with details', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Detail Chat' })

    const res = await app.request(`/api/v1/chats/${id}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        chat: {
          id: string
          title: string
          directoryId: string
          status: string
          messageCount: number
        }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.chat.title).toBe('Detail Chat')
    expect(body.data.chat.directoryId).toBe(dirId)
    expect(body.data.chat.status).toBe('idle')
    expect(body.data.chat.messageCount).toBe(0)
  })

  it('returns 404 for missing id', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/chats/${missing}`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('returns 400 for malformed id', async () => {
    const res = await app.request('/api/v1/chats/not-a-uuid', { method: 'GET' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'invalid chat id' })
  })
})

describe('POST /api/v1/chats — create', () => {
  it('creates a chat with directoryId and title', async () => {
    const dirId = await seedDirectory()

    const res = await app.request('/api/v1/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directoryId: dirId, title: 'New Chat' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { id: string; title: string; directoryId: string } }
    }
    expect(body.success).toBe(true)
    expect(body.data.chat.title).toBe('New Chat')
    expect(body.data.chat.directoryId).toBe(dirId)
    expect(body.data.chat.id).toBeTruthy()
    seededChatIds.push(body.data.chat.id)
  })

  it('400 when directoryId is missing', async () => {
    const res = await app.request('/api/v1/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No Dir' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/v1/chats/:id — update', () => {
  it('updates chat title', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Old Title' })

    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { title: string } }
    }
    expect(body.data.chat.title).toBe('New Title')
  })

  it('returns 404 for missing id', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/chats/${missing}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    })
    expect(res.status).toBe(404)
  })

  it('updates chat agentId', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Agent Chat' })
    const agentId = randomUUID()

    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { agentId: string | null } }
    }
    expect(body.data.chat.agentId).toBe(agentId)
  })

  it('updates chat flowId', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Flow Chat' })

    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: 'flow-xyz-123' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { flowId: string | null } }
    }
    expect(body.data.chat.flowId).toBe('flow-xyz-123')
  })

  it('clears chat agentId with null', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'Clear Chat' })

    // Set first
    await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: randomUUID() }),
    })
    // Then clear
    const res = await app.request(`/api/v1/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: null }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { chat: { agentId: string | null } }
    }
    expect(body.data.chat.agentId).toBeNull()
  })
})

describe('DELETE /api/v1/chats/:id — delete', () => {
  it('deletes a chat', async () => {
    const dirId = await seedDirectory()
    const id = await seedChat(dirId, { title: 'To Delete' })

    const res = await app.request(`/api/v1/chats/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { deleted: boolean; id: string }
    }
    expect(body.data.deleted).toBe(true)
    expect(body.data.id).toBe(id)

    const check = await app.request(`/api/v1/chats/${id}`, { method: 'GET' })
    expect(check.status).toBe(404)

    const idx = seededChatIds.indexOf(id)
    if (idx >= 0) seededChatIds.splice(idx, 1)
  })

  it('returns 404 for missing id', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/chats/${missing}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/chats/:id/messages — list messages', () => {
  it('returns messages sorted by created_at', async () => {
    const dirId = await seedDirectory()
    const chatId = await seedChat(dirId)
    const t0 = new Date('2026-07-08T10:00:00.000Z')
    const t1 = new Date('2026-07-09T10:00:00.000Z')
    const a = await seedMessage(chatId, { content: 'First' })
    const b = await seedMessage(chatId, { content: 'Second' })

    await runQuery(`UPDATE chat_messages SET created_at = $1 WHERE id = $2`, [t0, a])
    await runQuery(`UPDATE chat_messages SET created_at = $1 WHERE id = $2`, [t1, b])

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { items: Array<{ id: string; content: string }> }
    }
    expect(body.success).toBe(true)
    const items = body.data.items
    expect(items.length).toBe(2)
    expect(items[0].id).toBe(a)
    expect(items[1].id).toBe(b)
  })

  it('404 for missing chat', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/chats/${missing}/messages`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/chats/:id/messages — create message', () => {
  it('creates a message and updates chat counters', async () => {
    const dirId = await seedDirectory()
    const chatId = await seedChat(dirId)

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Hello world' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { message: { id: string; content: string; role: string } }
    }
    expect(body.success).toBe(true)
    expect(body.data.message.content).toBe('Hello world')
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.id).toBeTruthy()
    seededMessageIds.push(body.data.message.id)

    const chatRes = await app.request(`/api/v1/chats/${chatId}`, { method: 'GET' })
    const chatBody = (await chatRes.json()) as {
      success: boolean
      data: { chat: { messageCount: number; lastMessage: string | null } }
    }
    expect(chatBody.data.chat.messageCount).toBe(1)
    expect(chatBody.data.chat.lastMessage).toBe('Hello world')
  })

  it('400 when content is empty', async () => {
    const dirId = await seedDirectory()
    const chatId = await seedChat(dirId)

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('increments message_count and sets last_message on chat', async () => {
    const dirId = await seedDirectory()
    const chatId = await seedChat(dirId)

    await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'First message' }),
    })
    const res2 = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Second message' }),
    })
    expect(res2.status).toBe(200)
    seededMessageIds.push(((await res2.json()) as { data: { message: { id: string } } }).data.message.id)

    const chatRes = await app.request(`/api/v1/chats/${chatId}`, { method: 'GET' })
    const chatBody = (await chatRes.json()) as {
      success: boolean
      data: { chat: { messageCount: number; lastMessage: string | null } }
    }
    expect(chatBody.data.chat.messageCount).toBe(2)
    expect(chatBody.data.chat.lastMessage).toBe('Second message')
  })
})
