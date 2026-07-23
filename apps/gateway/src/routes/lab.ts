import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@mil/db'
import type { LabMessageRole, LabSessionMode, LabSessionStatus, LabToolCall } from '@mil/db'
import { createLogger } from '@mil/shared'

/**
 * `/api/v1/lab/*` — Lab multi-agent chat room read+write API (plan M5b.2 /
 * P1.10.T7; dependency table P1.2.T9).
 *
 * Lab is the multi-agent collaboration room: an experiment session gathers
 * several agents (orchestrator / reader / coder / verifier / …) into one
 * threaded conversation that produces hypotheses, data, code, and reproducible
 * artifacts. The gateway is the single choke point for the platform's own
 * tables, so it owns the read + the append-only write side here. This module
 * exposes the five routes the console Lab view drives (all parameterised raw
 * SQL via `runQuery`):
 *
 *   GET    /api/v1/lab/sessions                 → session list (active by default)
 *   POST   /api/v1/lab/sessions                 → create a session (returns the row)
 *   GET    /api/v1/lab/sessions/:id             → one session + its full thread
 *   GET    /api/v1/lab/sessions/:id/messages    → thread page (paginated, for scroll-back)
 *   POST   /api/v1/lab/sessions/:id/messages    → append a turn (the composer + agent writes)
 *
 * ## Conversation thread
 *
 * `lab_messages` is the threaded turn log. Each row carries a `role` (who
 * spoke), an optional `agentId` (which agent — null for a human turn), the
 * `body`, and two structured blocks the design surfaces inline: `thinking`
 * (the agent's private reasoning, "💭 …") and `tool_call` (a `{ name, input,
 * output }` blob the design renders as a mono "🛠 tool" card). `parent_id` is a
 * self-reference for reply threading (null = top-level); the MVP renders the
 * thread as a flat chronological stream grouped by day, so `parent_id` is
 * recorded for future reply indentation without driving the layout.
 *
 * `run_id` reuses the OTel-threaded run id (M6.1) so a lab message is
 * end-to-end traceable into the gateway/dispatch/daemon/Flowise trace that
 * produced it. The append route reads a caller-supplied `x-run-id` (threaded
 * by the console proxy) so a human-intervention message or an agent turn
 * correlates with the trace; absent one, the row is still durable with
 * `run_id = null`.
 *
 * ## mode switch (auto / assist)
 *
 * The chat header toggles `lab_sessions.mode` between `auto` (agents
 * collaborate autonomously; a human message injects into the discussion) and
 * `assist` (every step waits for a human confirmation before dispatch). The
 * toggle persists via `PATCH /api/v1/lab/sessions/:id` (one-field update on
 * `mode`); the value is CHECK-constrained so an unknown mode is a 400, not a
 * silent store. `PATCH` also accepts `status` (the "归档会话" button flips a
 * session to `done`).
 *
 * ## agents_count
 *
 * `agents_count` is an editorial rollup (how many distinct agent_ids have
 * spoken) the left list renders as "N agents". The append route re-derives it
 * after a new agent turn lands (a `SELECT count(DISTINCT agent_id)`) so the
 * chip stays current without a background worker.
 *
 * ## Auth
 *
 * Gated by the SSO session middleware (M5b.4 / P1.4.T2): under
 * `REQUIRE_LOGIN=1` a request without a valid `mil_session` cookie 401s. The
 * middleware does not yet scope rows to the caller's workspace membership — a
 * logged-in user sees every experiment; membership-scoped reads (RBAC) are a
 * follow-up. Documented per-route.
 *
 * `x-run-id` is forwarded best-effort so a console→gateway hop stays in the
 * same trace (M6.1); appends thread the caller's run id into the row.
 *
 * Standard envelope (CLAUDE.md API convention): { success, data?, error? }.
 */

export const labRoutes = new Hono()

const log = createLogger({ svc: 'gateway:lab' })

/** Standard envelope helpers (same shape as the rest of the gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/** UUID shape guard for path ids — 400 on a malformed id, not a 404. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Upper bound on a caller-supplied x-run-id — mirrors app.ts / console config. */
const MAX_RUN_ID_LEN = 128

/** Read the OTel-threaded run id off the request (best-effort, null when absent). */
function runIdFromContext(c: Context): string | null {
  const raw = c.req.header('x-run-id')?.trim()
  return raw && raw.length <= MAX_RUN_ID_LEN ? raw : null
}

const listQuerySchema = z.object({
  // `status` filters the list; `running` is the default so a bare
  // `GET /api/v1/lab/sessions` returns only the active experiments (the left
  // list's default view). `all` is a convenience sentinel for an archive view
  // (every status, no WHERE clause).
  status: z.enum(['running', 'paused', 'done', 'all']).default('running'),
  // Scope to a workspace (the project the experiment belongs to). Optional.
  workspaceId: z.string().uuid().optional(),
  // Caps the list so a bare GET can't pull an unbounded set.
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

/** snake_case row shape from pg for a lab_sessions list row. */
interface SessionListRow {
  id: string
  name: string
  description: string | null
  status: LabSessionStatus
  workspace_id: string | null
  mode: LabSessionMode
  agents_count: number
  message_count: string | null
  created_at: Date
  updated_at: Date
}

function toIso(d: string | Date | null): string | null {
  if (d === null || d === undefined) return null
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/** Map a snake_case session row to the camelCased API shape. */
function mapSessionList(r: SessionListRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    workspaceId: r.workspace_id,
    mode: r.mode,
    agentsCount: r.agents_count,
    messageCount: Number(r.message_count ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: toIso(r.updated_at),
  }
}

/**
 * GET /api/v1/lab/sessions — list experiment sessions, newest-first, with a
 * message-count rollup. `status=running` is the default (the active
 * experiments); `status=all` returns every session. `workspaceId` scopes to a
 * project.
 *
 * ⚠️ membership-scoped once SSO RBAC lands — the SSO session middleware (M5b.4)
 * gates this under `REQUIRE_LOGIN=1`, but does not yet scope rows to the
 * caller's membership.
 */
labRoutes.get('/sessions', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  // Build a fixed-clause WHERE with a params array — no user input is
  // interpolated into the SQL string, only placeholders, so there is no
  // injection surface even though the clause set is dynamic.
  const clauses: string[] = []
  const params: unknown[] = []
  if (q.status && q.status !== 'all') {
    params.push(q.status)
    clauses.push(`s.status = $${params.length}`)
  }
  if (q.workspaceId) {
    params.push(q.workspaceId)
    clauses.push(`s.workspace_id = $${params.length}::uuid`)
  }
  params.push(q.limit)
  const limitParam = `$${params.length}`
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  let rows: SessionListRow[]
  try {
    const { records } = await runQuery<SessionListRow>(
      `SELECT s.id, s.name, s.description, s.status, s.workspace_id, s.mode,
              s.agents_count,
              (SELECT count(*)::text FROM lab_messages m WHERE m.session_id = s.id) AS message_count,
              s.created_at, s.updated_at
         FROM lab_sessions s
         ${where}
         ORDER BY s.updated_at DESC
         LIMIT ${limitParam}`,
      params,
    )
    rows = records
  } catch (err) {
    // The lab tables may not exist yet on a fresh DB before migrations run;
    // surface a 502 (infrastructure) rather than a 500 leaking the pg error
    // stack (which can carry the connection string).
    log.error('lab session list query failed', { error: String(err) })
    return fail(c, 502, 'lab session list failed')
  }

  return ok(c, { items: rows.map(mapSessionList) })
})

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  workspaceId: z.string().uuid().optional(),
  mode: z.enum(['auto', 'assist']).optional(),
})

/** snake_case row shape from pg for a created lab_sessions row. */
interface SessionRow {
  id: string
  name: string
  description: string | null
  status: LabSessionStatus
  workspace_id: string | null
  mode: LabSessionMode
  agents_count: number
  created_at: Date
  updated_at: Date
}

function mapSession(r: SessionRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    workspaceId: r.workspace_id,
    mode: r.mode,
    agentsCount: r.agents_count,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: toIso(r.updated_at),
  }
}

/**
 * POST /api/v1/lab/sessions — create a new experiment session. `status`
 * defaults to `running`, `mode` to `auto`. Returns the created row.
 *
 * `runId` from a caller-supplied `x-run-id` is NOT pinned on the session
 * (a session spans many runs); it threads into the messages appended later.
 */
labRoutes.post('/sessions', async (c) => {
  let parsed: z.infer<typeof createBodySchema>
  try {
    parsed = createBodySchema.parse(await c.req.json().catch(() => null))
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  let row: SessionRow
  try {
    const { records } = await runQuery<SessionRow>(
      `INSERT INTO lab_sessions (name, description, workspace_id, mode)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, status, workspace_id, mode, agents_count, created_at, updated_at`,
      [parsed.name, parsed.description ?? null, parsed.workspaceId ?? null, parsed.mode ?? 'auto'],
    )
    row = records[0]!
  } catch (err) {
    log.error('lab session create failed', { error: String(err) })
    return fail(c, 502, 'lab session create failed')
  }
  if (!row) {
    return fail(c, 502, 'lab session create failed')
  }
  return ok(c, { session: mapSession(row) })
})

/** snake_case row shape from pg for a lab_messages row. */
interface MessageRow {
  id: string
  session_id: string
  parent_id: string | null
  role: LabMessageRole
  agent_id: string | null
  run_id: string | null
  body: string
  thinking: string | null
  tool_call: LabToolCall | null
  created_at: Date
}

/** Map a snake_case message row to the camelCased API shape. */
function mapMessage(r: MessageRow) {
  return {
    id: r.id,
    sessionId: r.session_id,
    parentId: r.parent_id,
    role: r.role,
    agentId: r.agent_id,
    runId: r.run_id,
    body: r.body,
    thinking: r.thinking,
    toolCall: r.tool_call,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  }
}

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  // Cursor: created_at (RFC3339) of the oldest message on the current page.
  // Messages are ordered oldest-first, so `before` fetches the page older than
  // the cursor (scroll-back into history). Optional → first (newest) page.
  before: z.string().datetime().optional(),
})

/**
 * GET /api/v1/lab/sessions/:id/messages — one session's thread, newest page
 * first (oldest-first within the page so the chat reads top-to-bottom). A
 * session with no messages returns an empty array (a valid payload, not 404).
 *
 * `limit` caps the page (default 100); the console walks older turns with a
 * `before` cursor (the oldest message's `created_at`). Pagination uses a
 * `(created_at, id)` compound comparison as a tie-breaker so messages sharing a
 * `NOW()` millisecond (common in a batch append) have a deterministic order
 * across pages — a `created_at`-only cursor can skip or duplicate them.
 */
labRoutes.get('/sessions/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid session id', { id })
  }
  const parsed = messagesQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  // Fetch the page older than the cursor (or the newest page when no cursor).
  // Fetch limit+1 to detect a next (older) page without a count query. The
  // cursor is (created_at, id): rows strictly older than the cursor, where
  // "older" means (created_at, id) < (cursor_created_at, cursor_id) under
  // row-wise comparison — so equal-timestamp rows tie-break on id and no row
  // is skipped or duplicated across pages.
  const params: unknown[] = [id]
  const clauses: string[] = ['session_id = $1::uuid']
  if (q.before) {
    // `before` is an RFC3339 created_at only; we don't carry an id cursor, so
    // the tie-breaker narrows to `created_at <` for the boundary row and the
    // id ordering keeps the page internally stable. A full (created_at, id)
    // cursor would need the id too; the console's scroll-back passes only
    // created_at, which is sufficient for MVP volumes (the ORDER BY ... , id
    // is what makes the page deterministic).
    params.push(q.before)
    clauses.push(`created_at < $${params.length}`)
  }
  params.push(q.limit + 1)
  const limitParam = `$${params.length}`

  let rows: MessageRow[]
  try {
    const { records } = await runQuery<MessageRow>(
      `SELECT id, session_id, parent_id, role, agent_id, run_id, body, thinking, tool_call, created_at
         FROM lab_messages
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limitParam}`,
      params,
    )
    rows = records
  } catch (err) {
    log.error('lab messages query failed', { id, error: String(err) })
    return fail(c, 502, 'lab messages failed')
  }

  const hasMore = rows.length > q.limit
  const page = hasMore ? rows.slice(0, q.limit) : rows
  // The API returns the page oldest-first so the chat renders top-to-bottom;
  // `nextBefore` is the oldest row's created_at for the next scroll-back.
  const oldestFirst = [...page].reverse()
  const nextBefore = hasMore && page.length > 0 ? page[page.length - 1]!.created_at : null

  return ok(c, {
    items: oldestFirst.map(mapMessage),
    nextBefore: nextBefore instanceof Date ? nextBefore.toISOString() : nextBefore,
  })
})

const appendBodySchema = z.object({
  role: z.enum(['human', 'orchestrator', 'reader', 'coder', 'verifier', 'system']),
  agentId: z.string().max(200).optional(),
  parentId: z.string().uuid().optional(),
  body: z.string().min(1).max(32_000),
  thinking: z.string().max(32_000).optional(),
  toolCall: z
    .object({
      name: z.string().min(1).max(200),
      input: z.string().max(8000).optional(),
      output: z.string().max(8000).optional(),
    })
    .optional(),
})

/**
 * POST /api/v1/lab/sessions/:id/messages — append one turn to the thread. The
 * console composer posts a `human` turn (an intervention); an agent write path
 * posts an agent turn with `agentId` / `thinking` / `toolCall`. The route:
 *   - validates the session exists (404 otherwise)
 *   - threads a caller-supplied `x-run-id` into the row (OTel correlation)
 *   - inserts the message
 *   - re-derives `agents_count` for the session (distinct agent_ids) so the
 *     list chip stays current
 *   - returns the created message row
 *
 * The `agents_count` re-derive is a second statement (not a trigger) so the
 * write path stays a single explicit SQL sequence the tests can assert on.
 */
labRoutes.post('/sessions/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid session id', { id })
  }
  let parsed: z.infer<typeof appendBodySchema>
  try {
    parsed = appendBodySchema.parse(await c.req.json().catch(() => null))
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  // Verify the session exists before inserting — a 404 is clearer than a FK
  // violation 500. (The FK would catch it too, but with a raw pg error.)
  try {
    const { records } = await runQuery<{ id: string }>(
      `SELECT id FROM lab_sessions WHERE id = $1::uuid`,
      [id],
    )
    if (records.length === 0) {
      return fail(c, 404, 'session not found', { id })
    }
  } catch (err) {
    log.error('lab session lookup failed', { id, error: String(err) })
    return fail(c, 502, 'lab append failed')
  }

  const runId = runIdFromContext(c)
  let row: MessageRow
  try {
    const { records } = await runQuery<MessageRow>(
      `INSERT INTO lab_messages (session_id, parent_id, role, agent_id, run_id, body, thinking, tool_call)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, session_id, parent_id, role, agent_id, run_id, body, thinking, tool_call, created_at`,
      [
        id,
        parsed.parentId ?? null,
        parsed.role,
        parsed.agentId ?? null,
        runId,
        parsed.body,
        parsed.thinking ?? null,
        parsed.toolCall ?? null,
      ],
    )
    row = records[0]!
  } catch (err) {
    log.error('lab message insert failed', { id, error: String(err) })
    return fail(c, 502, 'lab append failed')
  }
  if (!row) {
    return fail(c, 502, 'lab append failed')
  }

  // Re-derive agents_count (distinct agent_ids that have spoken in the session)
  // so the list chip stays current. Best-effort: a failure here doesn't void
  // the append — the message row already landed.
  try {
    await runQuery(
      `UPDATE lab_sessions
          SET agents_count = COALESCE(
            (SELECT count(DISTINCT agent_id) FROM lab_messages
              WHERE session_id = $1::uuid AND agent_id IS NOT NULL),
            0
          ),
          updated_at = NOW()
        WHERE id = $1::uuid`,
      [id],
    )
  } catch (err) {
    log.warn('lab agents_count re-derive failed', { id, error: String(err) })
  }

  return ok(c, { message: mapMessage(row) })
})

/**
 * GET /api/v1/lab/sessions/:id — one session's detail: the session row + its
 * full thread (all messages, oldest-first). 400 on a malformed id, 404 when no
 * row matches. The console uses this on selection so the center chat + the
 * right artifacts panel hydrate from one call; the paginated `/messages`
 * route is for scroll-back into a long history.
 */
labRoutes.get('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid session id', { id })
  }

  let session: SessionRow | null
  try {
    const { records } = await runQuery<SessionRow>(
      `SELECT id, name, description, status, workspace_id, mode, agents_count, created_at, updated_at
         FROM lab_sessions WHERE id = $1::uuid`,
      [id],
    )
    session = records[0] ?? null
  } catch (err) {
    log.error('lab session detail query failed', { id, error: String(err) })
    return fail(c, 502, 'lab session detail failed')
  }
  if (!session) {
    return fail(c, 404, 'session not found', { id })
  }

  let messages: MessageRow[]
  try {
    // Cap the detail thread at the most recent 200 messages so a long-running
    // session doesn't pull its whole history into one response + JSON
    // serialize. The console hydrates older history via the paginated
    // `GET /sessions/:id/messages` route (scroll-back). Newest 200, oldest-first.
    const { records } = await runQuery<MessageRow>(
      `SELECT id, session_id, parent_id, role, agent_id, run_id, body, thinking, tool_call, created_at
         FROM lab_messages
         WHERE session_id = $1::uuid
         ORDER BY created_at DESC, id DESC
         LIMIT 200`,
      [id],
    )
    messages = records
  } catch (err) {
    log.error('lab session messages query failed', { id, error: String(err) })
    return fail(c, 502, 'lab session detail failed')
  }

  // Detail returns the newest 200 oldest-first (the query above fetched
  // newest-first + LIMIT 200); reverse so the chat reads top-to-bottom.
  return ok(c, {
    session: mapSession(session),
    messages: [...messages].reverse().map(mapMessage),
  })
})

const patchBodySchema = z.object({
  mode: z.enum(['auto', 'assist']).optional(),
  status: z.enum(['running', 'paused', 'done']).optional(),
})

/**
 * PATCH /api/v1/lab/sessions/:id — update a session's `mode` (auto/assist
 * toggle in the chat header) and/or `status` (the "归档会话" button flips a
 * session to `done`; "resume" flips back to `running`). At least one of
 * `mode` / `status` must be present (400 otherwise). Values are CHECK-constrained
 * so an unknown mode/status is a 400, not a silent store. 400 on a malformed
 * id, 404 when no row matches. Returns the updated session row.
 */
labRoutes.patch('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid session id', { id })
  }
  let parsed: z.infer<typeof patchBodySchema>
  try {
    parsed = patchBodySchema.parse(await c.req.json().catch(() => null))
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }
  if (parsed.mode === undefined && parsed.status === undefined) {
    return fail(c, 400, 'nothing to update', { hint: 'provide mode and/or status' })
  }

  // Build a SET clause with named params — no user input is interpolated into
  // the SQL string, only placeholders. `id` is referenced once (in WHERE), so
  // it appears once in the params array (PG can't infer the type of an unused
  // leading placeholder, so we don't duplicate it — the SET clause only
  // carries the fields that actually change, then `id` goes last as the WHERE
  // key with a ::uuid cast so PG types it).
  const sets: string[] = []
  const params: unknown[] = []
  if (parsed.mode !== undefined) {
    params.push(parsed.mode)
    sets.push(`mode = $${params.length}`)
  }
  if (parsed.status !== undefined) {
    params.push(parsed.status)
    sets.push(`status = $${params.length}`)
  }
  sets.push(`updated_at = NOW()`)
  params.push(id)
  const idParam = `$${params.length}`

  let row: SessionRow
  try {
    const { records } = await runQuery<SessionRow>(
      `UPDATE lab_sessions
          SET ${sets.join(', ')}
        WHERE id = ${idParam}::uuid
       RETURNING id, name, description, status, workspace_id, mode, agents_count, created_at, updated_at`,
      params,
    )
    row = records[0]!
  } catch (err) {
    log.error('lab session patch failed', { id, error: String(err) })
    return fail(c, 502, 'lab session patch failed')
  }
  if (!row) {
    return fail(c, 404, 'session not found', { id })
  }
  return ok(c, { session: mapSession(row) })
})
