import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@mil/db'
import { createLogger } from '@mil/shared'
import {
  parseCommand,
  routeMessage,
  type RouteResult,
} from './chat-execute.js'

export const chatRoutes = new Hono()

const log = createLogger({ svc: 'gateway:chats' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
  directory_id: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const createBodySchema = z.object({
  directoryId: z.string().uuid(),
  title: z.string().min(1),
  agentId: z.string().uuid().optional(),
  flowId: z.string().optional(),
})

const updateBodySchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  agentId: z.string().uuid().nullable().optional(),
  flowId: z.string().max(200).nullable().optional(),
})

const createMessageBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z.string().min(1),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const createMessageWithExecBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z.string().min(1),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Optional agent id — overrides chat.agentId for this message only. */
  agentIdOverride: z.string().uuid().optional(),
  /** Optional flow id — overrides chat.flowId for this message only. */
  flowIdOverride: z.string().optional(),
})

interface ChatRow {
  id: string
  directory_id: string
  title: string
  status: string
  agent_id: string | null
  flow_id: string | null
  last_message: string | null
  message_count: number
  last_run_id: string | null
  created_at: Date
  updated_at: Date
}

interface ChatMessageRow {
  id: string
  chat_id: string
  role: string
  content: string
  run_id: string | null
  metadata: unknown
  created_at: Date
}

function normalizeChat(r: ChatRow) {
  return {
    id: r.id,
    directoryId: r.directory_id,
    title: r.title,
    status: r.status,
    agentId: r.agent_id,
    flowId: r.flow_id,
    lastMessage: r.last_message,
    messageCount: r.message_count,
    lastRunId: r.last_run_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

function normalizeMsg(r: ChatMessageRow) {
  let metadata: Record<string, unknown> = {}
  if (typeof r.metadata === 'object' && r.metadata !== null && !Array.isArray(r.metadata)) {
    metadata = r.metadata as Record<string, unknown>
  }
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    metadata,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  }
}

chatRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  let rows: ChatRow[]
  try {
    const { records } = await runQuery<ChatRow>(
      `SELECT id, directory_id, title, status, agent_id, flow_id,
              last_message, message_count, last_run_id,
              created_at, updated_at
         FROM chats
         WHERE directory_id = $1::uuid
         ORDER BY updated_at DESC
         LIMIT $2`,
      [q.directory_id, q.limit],
    )
    rows = records
  } catch (err) {
    log.error('chat list query failed', { error: String(err) })
    return fail(c, 502, 'chat list failed')
  }

  return ok(c, {
    items: rows.map((r) => normalizeChat(r)),
  })
})

chatRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let row: ChatRow | null
  try {
    const { records } = await runQuery<ChatRow>(
      `SELECT id, directory_id, title, status, agent_id, flow_id,
              last_message, message_count, last_run_id,
              created_at, updated_at
         FROM chats
         WHERE id = $1::uuid`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('chat detail query failed', { id, error: String(err) })
    return fail(c, 502, 'chat detail failed')
  }
  if (!row) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { chat: normalizeChat(row) })
})

chatRoutes.post('/', async (c) => {
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

  let row: ChatRow | null
  try {
    const { records } = await runQuery<ChatRow>(
      `INSERT INTO chats (directory_id, title, agent_id, flow_id)
       VALUES ($1::uuid, $2, $3, $4)
       RETURNING id, directory_id, title, status, agent_id, flow_id,
                 last_message, message_count, last_run_id,
                 created_at, updated_at`,
      [
        data.directoryId,
        data.title,
        data.agentId ?? null,
        data.flowId ?? null,
      ],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('chat create failed', { error: String(err) })
    return fail(c, 502, 'chat create failed')
  }
  if (!row) {
    return fail(c, 502, 'chat create failed')
  }

  return ok(c, { chat: normalizeChat(row) })
})

chatRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
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

  if (data.title !== undefined) {
    params.push(data.title)
    sets.push(`title = $${params.length}`)
  }
  if (data.status !== undefined) {
    params.push(data.status)
    sets.push(`status = $${params.length}`)
  }
  if (data.agentId !== undefined) {
    params.push(data.agentId)
    sets.push(`agent_id = $${params.length}`)
  }
  if (data.flowId !== undefined) {
    params.push(data.flowId)
    sets.push(`flow_id = $${params.length}`)
  }

  if (sets.length === 0) {
    let existing: ChatRow | null
    try {
      const { records } = await runQuery<ChatRow>(
        `SELECT id, directory_id, title, status, agent_id, flow_id,
                last_message, message_count, last_run_id,
                created_at, updated_at
           FROM chats
           WHERE id = $1::uuid`,
        [id],
      )
      existing = records[0] ?? null
    } catch (err) {
      log.error('chat detail query failed', { id, error: String(err) })
      return fail(c, 502, 'chat update failed')
    }
    if (!existing) {
      return fail(c, 404, 'chat not found', { id })
    }
    return ok(c, { chat: normalizeChat(existing) })
  }

  sets.push(`updated_at = NOW()`)
  params.push(id)
  const idParam = `$${params.length}::uuid`

  let row: ChatRow | null
  try {
    const { records } = await runQuery<ChatRow>(
      `UPDATE chats
          SET ${sets.join(', ')}
        WHERE id = ${idParam}
       RETURNING id, directory_id, title, status, agent_id, flow_id,
                 last_message, message_count, last_run_id,
                 created_at, updated_at`,
      params,
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('chat update failed', { id, error: String(err) })
    return fail(c, 502, 'chat update failed')
  }
  if (!row) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { chat: normalizeChat(row) })
})

chatRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let deletedId: string | null
  try {
    const { records } = await runQuery<{ id: string }>(
      `DELETE FROM chats WHERE id = $1::uuid RETURNING id`,
      [id],
    )
    deletedId = records[0]?.id ?? null
  } catch (err) {
    log.error('chat delete failed', { id, error: String(err) })
    return fail(c, 502, 'chat delete failed')
  }
  if (!deletedId) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { deleted: true, id: deletedId })
})

chatRoutes.get('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  try {
    const { records: chatRecords } = await runQuery<{ id: string }>(
      `SELECT id FROM chats WHERE id = $1::uuid`,
      [id],
    )
    if (chatRecords.length === 0) {
      return fail(c, 404, 'chat not found', { id })
    }
  } catch (err) {
    log.error('chat lookup failed', { id, error: String(err) })
    return fail(c, 502, 'chat messages failed')
  }

  let rows: ChatMessageRow[]
  try {
    const { records } = await runQuery<ChatMessageRow>(
      `SELECT id, chat_id, role, content, run_id, metadata, created_at
         FROM chat_messages
         WHERE chat_id = $1::uuid
         ORDER BY created_at ASC`,
      [id],
    )
    rows = records
  } catch (err) {
    log.error('chat messages query failed', { id, error: String(err) })
    return fail(c, 502, 'chat messages failed')
  }

  return ok(c, { items: rows.map((r) => normalizeMsg(r)) })
})

chatRoutes.post('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createMessageWithExecBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  // Only 'user' role messages trigger execution routing.
  // 'assistant'/'system'/'tool' are writes from the stream consumer or other
  // system paths and should not re-route.
  let msgRow: ChatMessageRow | null
  try {
    const result = await runQuery<ChatMessageRow>(
      `WITH chat_check AS (
         SELECT id FROM chats WHERE id = $1::uuid
       ),
       inserted AS (
         INSERT INTO chat_messages (chat_id, role, content, run_id, metadata)
         SELECT $1::uuid, $2, $3, $4, $5
          FROM chat_check
         RETURNING id, chat_id, role, content, run_id, metadata, created_at
       ),
       updated AS (
         UPDATE chats
            SET last_message = $3,
                message_count = message_count + 1,
                updated_at = NOW()
          WHERE id = $1::uuid
       )
       SELECT * FROM inserted`,
      [
        id,
        data.role,
        data.content,
        data.runId ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    )
    msgRow = result.records[0] ?? null
  } catch (err) {
    log.error('chat message create failed', { id, error: String(err) })
    return fail(c, 502, 'chat message create failed')
  }
  if (!msgRow) {
    return fail(c, 404, 'chat not found', { id })
  }

  // Non-user roles: return the message without routing.
  if (data.role !== 'user') {
    return ok(c, { message: normalizeMsg(msgRow) })
  }

  // User role: route the message.
  const route = await routeMessage(id, data.content, {
    agentIdOverride: data.agentIdOverride,
    flowIdOverride: data.flowIdOverride,
  })

  if (route.mode === 'stream') {
    return ok(c, {
      message: normalizeMsg(msgRow),
      mode: 'stream',
      chatRunId: route.chatRunId ?? null,
    })
  }

  // JSON mode: @-command ack or routing error.
  return ok(c, {
    message: normalizeMsg(msgRow),
    mode: 'json',
    payload: route.payload,
    error: route.error,
    systemMessageId: route.systemMessageId ?? null,
  })
})

/**
 * GET /api/v1/chats/:id/stream — SSE stream of the chat's active run.
 *
 * This is a thin pass-through to Flowise prediction. The chat-execute route
 * marked the chat as 'running' and the caller (console) subscribes here to
 * receive the assistant's token stream.
 *
 * The chat's flow_id (or agent_id → resolved flow) is used as the upstream
 * prediction target. sessionId = chatId so Flowise's Flow State resumes the
 * correct memory.
 */
chatRoutes.get('/:id/stream', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // Resolve chat → flowId
  let chat: { flow_id: string | null; agent_id: string | null } | null
  try {
    const { records } = await runQuery<{ flow_id: string | null; agent_id: string | null }>(
      `SELECT flow_id, agent_id FROM chats WHERE id = $1::uuid`,
      [id],
    )
    chat = records[0] ?? null
  } catch (err) {
    log.error('chat stream lookup failed', { id, error: String(err) })
    return fail(c, 502, 'chat stream failed')
  }
  if (!chat) return fail(c, 404, 'chat not found', { id })
  if (!chat.flow_id) {
    return fail(c, 400, 'chat has no flow_id — bind a flow via PATCH /chats/:id first', { id })
  }

  // Build the upstream prediction URL — same shape as /api/chat/route.ts used.
  const runId = c.req.header('x-run-id')?.trim() || randomUUID()
  const upstreamUrl = `${process.env.FLOWISE_URL ?? 'http://localhost:3101'}/api/v1/prediction/${encodeURIComponent(chat.flow_id)}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-run-id': runId,
      },
      body: JSON.stringify({
        question: '', // stream continuation — no new question, just subscribe
        streaming: true,
        overrideConfig: { sessionId: id },
      }),
    })
  } catch (err) {
    log.error('chat stream upstream failed', { id, flowId: chat.flow_id, error: String(err) })
    return fail(c, 502, 'upstream unavailable')
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return fail(c, 502, 'prediction failed', { status: upstream.status, detail: detail.slice(0, 500) })
  }

  // Pipe the SSE body through. Preserve content-type so the browser sees text/event-stream.
  const respHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  respHeaders.set('x-run-id', runId)
  respHeaders.set('cache-control', 'no-cache')
  return new Response(upstream.body, { status: 200, headers: respHeaders })
})

interface RunRow {
  id: string
  status: string
  created_at: Date
  finished_at: Date | null
}

chatRoutes.get('/:id/runs', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // runs.chat_id is TEXT, so cast chat id to text for the comparison.
  let rows: RunRow[]
  try {
    const { records } = await runQuery<RunRow>(
      `SELECT id, status, created_at, finished_at
         FROM runs
         WHERE chat_id = $1::text
         ORDER BY created_at DESC
         LIMIT 50`,
      [id],
    )
    rows = records
  } catch (err) {
    log.error('chat runs query failed', { id, error: String(err) })
    return fail(c, 502, 'chat runs failed')
  }

  return ok(c, {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      finishedAt: r.finished_at instanceof Date ? r.finished_at.toISOString() : (r.finished_at ? new Date(r.finished_at).toISOString() : null),
    })),
  })
})
