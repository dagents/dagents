import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@mil/db'
import { createLogger } from '@mil/shared'

export const directoryRoutes = new Hono()

const log = createLogger({ svc: 'gateway:directories' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const createBodySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
})

interface DirectoryRow {
  id: string
  path: string
  name: string
  settings: unknown
  chat_count: string | null
  created_at: Date
  updated_at: Date
}

function normalizeDir(r: DirectoryRow) {
  let settings: Record<string, unknown> = {}
  if (typeof r.settings === 'object' && r.settings !== null && !Array.isArray(r.settings)) {
    settings = r.settings as Record<string, unknown>
  }
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    settings,
    chatCount: Number(r.chat_count ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

directoryRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  let rows: DirectoryRow[]
  try {
    const { records } = await runQuery<DirectoryRow>(
      `SELECT d.id, d.path, d.name, d.settings,
              (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = d.id) AS chat_count,
              d.created_at, d.updated_at
         FROM directories d
         ORDER BY d.updated_at DESC
         LIMIT $1`,
      [q.limit],
    )
    rows = records
  } catch (err) {
    log.error('directory list query failed', { error: String(err) })
    return fail(c, 502, 'directory list failed')
  }

  return ok(c, {
    items: rows.map((r) => normalizeDir(r)),
  })
})

directoryRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid directory id', { id })
  }

  let row: DirectoryRow | null
  try {
    const { records } = await runQuery<DirectoryRow>(
      `SELECT d.id, d.path, d.name, d.settings,
              (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = d.id) AS chat_count,
              d.created_at, d.updated_at
         FROM directories d
         WHERE d.id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('directory detail query failed', { id, error: String(err) })
    return fail(c, 502, 'directory detail failed')
  }
  if (!row) {
    return fail(c, 404, 'directory not found', { id })
  }

  return ok(c, { directory: normalizeDir(row) })
})

directoryRoutes.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data
  const name = data.name ?? data.path.split('/').filter(Boolean).pop() ?? data.path

  let row: DirectoryRow | null
  try {
    const { records } = await runQuery<DirectoryRow>(
      `INSERT INTO directories (path, name, settings)
       VALUES ($1, $2, $3)
       RETURNING id, path, name, settings,
                 (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = directories.id) AS chat_count,
                 created_at, updated_at`,
      [data.path, name, JSON.stringify(data.settings ?? {})],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('directory create failed', { error: String(err) })
    return fail(c, 502, 'directory create failed')
  }
  if (!row) {
    return fail(c, 502, 'directory create failed')
  }

  return ok(c, { directory: normalizeDir(row) })
})

directoryRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid directory id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = updateBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  const sets: string[] = []
  const params: unknown[] = []

  if (data.name !== undefined) {
    params.push(data.name)
    sets.push(`name = $${params.length}`)
  }
  if (data.settings !== undefined) {
    params.push(JSON.stringify(data.settings))
    sets.push(`settings = $${params.length}`)
  }

  if (sets.length === 0) {
    let existing: DirectoryRow | null
    try {
      const { records } = await runQuery<DirectoryRow>(
        `SELECT d.id, d.path, d.name, d.settings,
                (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = d.id) AS chat_count,
                d.created_at, d.updated_at
           FROM directories d
           WHERE d.id = $1`,
        [id],
      )
      existing = records[0] ?? null
    } catch (err) {
      log.error('directory detail query failed', { id, error: String(err) })
      return fail(c, 502, 'directory update failed')
    }
    if (!existing) {
      return fail(c, 404, 'directory not found', { id })
    }
    return ok(c, { directory: normalizeDir(existing) })
  }

  params.push(id)
  const idParam = `$${params.length}`

  let row: DirectoryRow | null
  try {
    const { records } = await runQuery<DirectoryRow>(
      `UPDATE directories
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = ${idParam}
       RETURNING id, path, name, settings,
                 (SELECT count(*)::text FROM chats ch WHERE ch.directory_id = directories.id) AS chat_count,
                 created_at, updated_at`,
      params,
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('directory update failed', { id, error: String(err) })
    return fail(c, 502, 'directory update failed')
  }
  if (!row) {
    return fail(c, 404, 'directory not found', { id })
  }

  return ok(c, { directory: normalizeDir(row) })
})

directoryRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid directory id', { id })
  }

  let deletedId: string | null
  try {
    const { records } = await runQuery<{ id: string }>(
      `DELETE FROM directories WHERE id = $1 RETURNING id`,
      [id],
    )
    deletedId = records[0]?.id ?? null
  } catch (err) {
    log.error('directory delete failed', { id, error: String(err) })
    return fail(c, 502, 'directory delete failed')
  }
  if (!deletedId) {
    return fail(c, 404, 'directory not found', { id })
  }

  return ok(c, { deleted: true, id: deletedId })
})
