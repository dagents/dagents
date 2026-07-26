import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

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
  if (seededDirectoryIds.length === 0) return
  await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [
    seededDirectoryIds,
  ])
  seededDirectoryIds = []
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

async function seedChat(directoryId: string): Promise<string> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO chats (id, directory_id, title)
     VALUES ($1, $2, $3)`,
    [id, directoryId, `Chat ${id.slice(0, 8)}`],
  )
  return id
}

describe('GET /api/v1/directories — list', () => {
  it('returns directories sorted by updated_at desc', async () => {
    const t0 = new Date('2026-07-08T10:00:00.000Z')
    const t1 = new Date('2026-07-09T10:00:00.000Z')
    const a = await seedDirectory({ name: 'Old Dir' })
    const b = await seedDirectory({ name: 'New Dir' })

    await runQuery(`UPDATE directories SET updated_at = $1 WHERE id = $2`, [t0, a])
    await runQuery(`UPDATE directories SET updated_at = $1 WHERE id = $2`, [t1, b])

    const res = await app.request('/api/v1/directories', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: Array<{ id: string; name: string }> } }
    expect(body.success).toBe(true)
    const items = body.data.items
    const bIdx = items.findIndex((i) => i.id === b)
    const aIdx = items.findIndex((i) => i.id === a)
    expect(bIdx).toBeLessThan(aIdx)
    void a
    void b
  })

  it('respects limit query param', async () => {
    for (let i = 0; i < 5; i++) {
      await seedDirectory({ name: `Dir ${i}` })
    }
    const res = await app.request('/api/v1/directories?limit=2', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: unknown[] } }
    expect(body.data.items.length).toBe(2)
  })

  it('rejects an out-of-range limit with 400', async () => {
    const res = await app.request('/api/v1/directories?limit=9999', { method: 'GET' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/directories/:id — detail', () => {
  it('returns directory with chat count and settings', async () => {
    const id = await seedDirectory({
      name: 'Detail Dir',
      path: '/work/detail',
      settings: { theme: 'dark' },
    })
    await seedChat(id)
    await seedChat(id)
    await seedChat(id)

    const res = await app.request(`/api/v1/directories/${id}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        directory: {
          id: string
          name: string
          path: string
          settings: Record<string, unknown>
          chatCount: number
        }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.directory.name).toBe('Detail Dir')
    expect(body.data.directory.path).toBe('/work/detail')
    expect(body.data.directory.settings).toEqual({ theme: 'dark' })
    expect(body.data.directory.chatCount).toBe(3)
  })

  it('returns 404 for missing id', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/directories/${missing}`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('returns 400 for malformed id', async () => {
    const res = await app.request('/api/v1/directories/not-a-uuid', { method: 'GET' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'invalid directory id' })
  })
})

describe('POST /api/v1/directories — create', () => {
  it('creates a directory with path and name', async () => {
    const res = await app.request('/api/v1/directories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/projects/new', name: 'New Project' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { directory: { id: string; path: string; name: string } }
    }
    expect(body.success).toBe(true)
    expect(body.data.directory.path).toBe('/projects/new')
    expect(body.data.directory.name).toBe('New Project')
    expect(body.data.directory.id).toBeTruthy()
    seededDirectoryIds.push(body.data.directory.id)
  })

  it('defaults name to last segment of path', async () => {
    const res = await app.request('/api/v1/directories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/my-folder' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { directory: { name: string } }
    }
    expect(body.data.directory.name).toBe('my-folder')
    seededDirectoryIds.push((body.data.directory as unknown as { id: string }).id)
  })

  it('returns 400 when path is missing', async () => {
    const res = await app.request('/api/v1/directories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No Path' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/v1/directories/:id — update', () => {
  it('updates directory name', async () => {
    const id = await seedDirectory({ name: 'Old Name' })

    const res = await app.request(`/api/v1/directories/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { directory: { name: string } }
    }
    expect(body.data.directory.name).toBe('New Name')
  })

  it('updates settings', async () => {
    const id = await seedDirectory({ settings: { a: 1 } })

    const res = await app.request(`/api/v1/directories/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { b: 2 } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { directory: { settings: Record<string, unknown> } }
    }
    expect(body.data.directory.settings).toEqual({ b: 2 })
  })

  it('returns 404 for missing id', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/directories/${missing}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/v1/directories/:id — delete', () => {
  it('deletes a directory', async () => {
    const id = await seedDirectory({ name: 'To Delete' })

    const res = await app.request(`/api/v1/directories/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { deleted: boolean; id: string }
    }
    expect(body.data.deleted).toBe(true)
    expect(body.data.id).toBe(id)

    const check = await app.request(`/api/v1/directories/${id}`, { method: 'GET' })
    expect(check.status).toBe(404)

    const idx = seededDirectoryIds.indexOf(id)
    if (idx >= 0) seededDirectoryIds.splice(idx, 1)
  })

  it('returns 404 for missing id', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/directories/${missing}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
