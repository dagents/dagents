import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { DagExecutor, NodeRegistry, allNodes, SseStreamer, type FlowData } from '@dagents/workflow'
import {
  parseCommand,
  routeMessage,
  type RouteResult,
} from './chat-execute.js'
import { enqueueTask, getTask, getTaskEvents } from './dispatch/service.js'

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

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  directory_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const createBodySchema = z.object({
  directoryId: z.string().uuid(),
  title: z.string().min(1).max(200),
  agentId: z.string().uuid().optional(),
  flowId: z.string().max(200).optional(),
})

const updateBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.string().min(1).optional(),
  agentId: z.string().uuid().nullable().optional(),
  flowId: z.string().max(200).nullable().optional(),
})

const createMessageBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z.string().min(1).refine((s) => !s.includes('\x00'), 'content must not contain null bytes'),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const createMessageWithExecBodySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z.string().min(1).refine((s) => !s.includes('\x00'), 'content must not contain null bytes'),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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

/**
 * GET /api/v1/chats/search?q=keyword&directory_id=xxx&limit=20
 *
 * Full-text chat history search across chats.title and chat_messages.content.
 * Returns results grouped by chat — each result has a truncated snippet with
 * the matched substring wrapped in <mark>…</mark> for client-side highlight.
 *
 * q must be non-empty (min 1 char) — empty/whitespace queries are rejected
 * with 400. limit is capped at 50. If directory_id is provided, results are
 * scoped to chats in that directory; otherwise all directories are searched.
 *
 * Match precedence: title matches are returned first (they are usually the
 * strongest signal), then content matches. A chat that matches on content
 * produces one row per matching message so the user can jump to the specific
 * message context.
 *
 * The <mark> wrapping is done in JS, not SQL, to keep the query legible. SQL
 * returns the raw title (for title matches) or a ~200-char window centered on
 * the first hit (for content matches); the JS post-process re-locates the
 * (case-insensitive) hit and wraps it.
 */
chatRoutes.get('/search', async (c) => {
  const parsed = searchQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  // Escape SQL LIKE wildcards in the user query so a literal '%', '_', or '\'
  // in the query is treated as a literal char, not a wildcard. We then use
  // ILIKE … ESCAPE '\' so the escaped sequence is interpreted correctly.
  const escaped = q.q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const likePattern = `%${escaped}%`

  const params: unknown[] = [likePattern, q.q]
  let dirFilter = ''
  if (q.directory_id) {
    params.push(q.directory_id)
    dirFilter = `AND ch.directory_id = $${params.length}::uuid`
  }
  params.push(q.limit)
  const limitParam = `$${params.length}`

  interface SearchRow {
    chat_id: string
    chat_title: string
    directory_id: string
    directory_name: string
    snippet_raw: string
    match_type: 'title' | 'content'
    created_at: Date
  }

  let rows: SearchRow[]
  try {
    const { records } = await runQuery<SearchRow>(
      `
      -- Title matches: snippet_raw is the raw title (capped at 200 chars).
      SELECT ch.id            AS chat_id,
             ch.title         AS chat_title,
             ch.directory_id  AS directory_id,
             d.name           AS directory_name,
             left(ch.title, 200) AS snippet_raw,
             'title'::text    AS match_type,
             ch.created_at    AS created_at
        FROM chats ch
        JOIN directories d ON d.id = ch.directory_id
       WHERE ch.title ILIKE $1 ESCAPE '\\'
         ${dirFilter}
       UNION ALL
      -- Content matches: snippet_raw is a ~200-char window centered on the
      -- first hit (60 chars of context before, then the hit, then the tail).
        SELECT ch.id            AS chat_id,
               ch.title         AS chat_title,
               ch.directory_id  AS directory_id,
               d.name           AS directory_name,
               substring(cm.content
                        FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(cm.content)) - 60)
                        FOR 200) AS snippet_raw,
               'content'::text  AS match_type,
               cm.created_at    AS created_at
          FROM chat_messages cm
          JOIN chats ch ON ch.id = cm.chat_id
          JOIN directories d ON d.id = ch.directory_id
         WHERE cm.content ILIKE $1 ESCAPE '\\'
           ${dirFilter}
      ORDER BY
        CASE match_type WHEN 'title' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT ${limitParam}`,
      params,
    )
    rows = records
  } catch (err) {
    log.error('chat search query failed', { q: q.q, error: String(err) })
    return fail(c, 502, 'chat search failed')
  }

  // Wrap the (first, case-insensitive) match in <mark>…</mark>. Truncate long
  // snippets with an ellipsis. HTML special chars are escaped so user-controlled
  // content can't inject markup; the <mark> tags we add ourselves are the only
  // HTML in the output.
  const needle = q.q.toLowerCase()
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const wrapHit = (raw: string, isContent: boolean): string => {
    const lower = raw.toLowerCase()
    const idx = lower.indexOf(needle)
    // Leading ellipsis when the content window starts mid-string (the SQL
    // window begins up to 60 chars before the hit, so the snippet usually
    // doesn't start at offset 0 of the original message).
    const leadingEllipsis = isContent && raw.length > 0 && idx > 0 ? '…' : ''
    if (idx < 0) {
      const safe = escapeHtml(raw)
      return raw.length > 200 ? safe.slice(0, 200) + '…' : safe
    }
    const before = escapeHtml(raw.slice(0, idx))
    const hit = escapeHtml(raw.slice(idx, idx + needle.length))
    const afterRaw = raw.slice(idx + needle.length)
    const after = escapeHtml(afterRaw.length > 200 - idx ? afterRaw.slice(0, 200 - idx) + '…' : afterRaw)
    return `${leadingEllipsis}${before}<mark>${hit}</mark>${after}`
  }

  return ok(c, {
    items: rows.map((r) => ({
      chatId: r.chat_id,
      chatTitle: r.chat_title,
      snippet: wrapHit(r.snippet_raw, r.match_type === 'content'),
      matchType: r.match_type,
      directoryId: r.directory_id,
      directoryName: r.directory_name,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    })),
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
 * POST /api/v1/chats/:id/reset — clear a failed chat back to 'idle'.
 *
 * Used by the console's error-recovery flow before retrying an agent run.
 * Only flips `failed` → `idle`; a non-failed chat is reset to `idle` too
 * (idempotent) so the caller doesn't have to branch on current status.
 * Returns the updated chat so the console can sync its breadcrumb.
 */
chatRoutes.post('/:id/reset', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  let row: ChatRow | null
  try {
    const { records } = await runQuery<ChatRow>(
      `UPDATE chats
          SET status = 'idle', updated_at = NOW()
        WHERE id = $1::uuid
       RETURNING id, directory_id, title, status, agent_id, flow_id,
                 last_message, message_count, last_run_id,
                 created_at, updated_at`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('chat reset failed', { id, error: String(err) })
    return fail(c, 502, 'chat reset failed')
  }
  if (!row) {
    return fail(c, 404, 'chat not found', { id })
  }

  return ok(c, { chat: normalizeChat(row) })
})

/**
 * Agent-based execution: dispatch a task to the agent via the dispatch
 * service and stream the output back as SSE.
 *
 * When the user selects an agent in the chat UI (e.g. claude-code), the
 * chat has agent_id but no flow_id. We enqueue a dispatch task (via the
 * in-process service function — no HTTP round-trip), then poll
 * dispatch_task_events and stream them as SSE tokens to the client.
 */
async function streamAgentExecution(
  c: Context,
  chatId: string,
  agentId: string,
  prompt: string | null,
): Promise<Response> {
  const runId = randomUUID()

  // 1. Create a dispatch task for this agent (in-process service call).
  let taskId: string
  try {
    const result = await enqueueTask({
      agentDaemonId: agentId,
      runId,
      prompt: prompt ?? '',
    })
    taskId = result.taskId
  } catch (err) {
    log.error('dispatch invoke failed', { agentId, error: String(err) })
    return c.json({ success: false, error: 'dispatch invoke failed', detail: String(err) }, 502 as ContentfulStatusCode)
  }

  log.info('dispatched agent task', { chatId, agentId, taskId, runId })

  // 2. Build a live ReadableStream that polls dispatch_task_events and
  //    yields SSE frames. This is a proper live stream (not the buffered
  //    SseStreamer which drains once), suitable for long-running agents.
  const encoder = new TextEncoder()
  let lastSeq = 0

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const POLL_INTERVAL = 500
      let terminal = false

      while (!terminal) {
        try {
          // Check task status (in-process service call)
          const task = await getTask(taskId)
          if (task) {
            if (task.status === 'completed' || task.status === 'failed') {
              terminal = true
            }
          }

          // Fetch new events since lastSeq (in-process service call)
          const events = await getTaskEvents(taskId, lastSeq)
          for (const evt of events) {
            if (evt.seq <= lastSeq) continue
            lastSeq = evt.seq
            const p = (evt.payload ?? {}) as Record<string, unknown>
            const text =
              typeof p.content === 'string' ? p.content
              : typeof p.output === 'string' ? p.output
              : typeof p.status === 'string' ? p.status
              : JSON.stringify(p)
            controller.enqueue(encoder.encode(`event: token\ndata: ${text}\n\n`))
          }
        } catch (err) {
          log.warn('agent event poll error', { taskId, error: String(err) })
        }

        if (!terminal) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL))
        }
      }

      // Send end event
      controller.enqueue(encoder.encode('event: end\ndata: [DONE]\n\n'))
      controller.close()

      // Update chat status
      try {
        await runQuery(
          `UPDATE chats SET status = 'idle', updated_at = NOW() WHERE id = $1::uuid`,
          [chatId],
        )
      } catch {
        // best-effort status reset — ignore errors once the stream has closed
      }
    },
  })

  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('x-run-id', runId)

  return c.body(readable)
}

/**
 * GET /api/v1/chats/:id/stream — SSE stream of the chat's active run.
 *
 * Executes the chat's bound workflow using the internal @dagents/workflow engine
 * and streams token events via SSE.
 */
chatRoutes.get('/:id/stream', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid chat id', { id })
  }

  // Fetch the latest user message (the prompt for execution) alongside chat metadata.
  let chat: { flow_id: string | null; agent_id: string | null } | null
  let lastUserMsg: string | null = null
  try {
    const { records: chatRows } = await runQuery<{ flow_id: string | null; agent_id: string | null }>(
      `SELECT flow_id, agent_id FROM chats WHERE id = $1::uuid`,
      [id],
    )
    chat = chatRows[0] ?? null
    if (chat) {
      const { records: msgRows } = await runQuery<{ content: string }>(
        `SELECT content FROM chat_messages WHERE chat_id = $1::uuid AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
        [id],
      )
      lastUserMsg = msgRows[0]?.content ?? null
    }
  } catch (err) {
    log.error('chat stream lookup failed', { id, error: String(err) })
    return fail(c, 502, 'chat stream failed')
  }
  if (!chat) return fail(c, 404, 'chat not found', { id })

  // ─── Agent-based execution (no flow_id, but agent_id is set) ───
  // When the user selects an agent in the chat UI (e.g. claude-code),
  // chat.agent_id is set but flow_id may be null. We dispatch a task
  // to the agent via the dispatch service and stream the output back.
  if (!chat.flow_id && chat.agent_id) {
    return await streamAgentExecution(c, id, chat.agent_id, lastUserMsg)
  }

  // ─── Flow-based execution ───
  if (!chat.flow_id) {
    return fail(c, 400, 'chat has no flow_id — bind a flow via PATCH /chats/:id first', { id })
  }

  let flowRow: { flow_data: unknown } | null
  try {
    const { records } = await runQuery<{ flow_data: unknown }>(
      `SELECT flow_data FROM flows WHERE id = $1::uuid`,
      [chat.flow_id],
    )
    flowRow = records[0] ?? null
  } catch (err) {
    log.error('chat stream flow lookup failed', { id, flowId: chat.flow_id, error: String(err) })
    return fail(c, 502, 'chat stream failed')
  }
  if (!flowRow) {
    return fail(c, 404, 'flow not found', { flowId: chat.flow_id })
  }

  const flowData = flowRow.flow_data as FlowData
  if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
    return fail(c, 400, 'invalid flow data', { flowId: chat.flow_id })
  }

  const runId = c.req.header('x-run-id')?.trim() || randomUUID()
  const streamer = new SseStreamer(id)

  const registry = new NodeRegistry()
  registry.registerMany(allNodes())
  const executor = new DagExecutor(registry)

  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('x-run-id', runId)

  ;(async () => {
    try {
      await executor.execute(flowData, {}, {
        chatId: id,
        runId,
        state: {},
        isLastNode: true,
        sseStreamer: streamer,
      })
    } catch (err) {
      log.error('chat stream execution failed', { id, error: String(err) })
    }
  })()

  return c.body(streamer.toReadableStream())
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
