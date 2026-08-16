import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import type { AuditActorType, AuditTargetType } from '@dagents/db'
import { createLogger } from '@dagents/shared'

/**
 * `GET /api/v1/audit` — audit log query endpoint (plan M6.6 / spec §1.4 职责 #5).
 *
 * The audit trail is written fire-and-forget by the token routes + the
 * scheduler's version-lock path; this endpoint is the read side — an operator
 * (or a future console "审计" page) lists audit records filtered by actor /
 * action / target / run_id, newest-first, paginated.
 *
 * Filters are all optional + validated by zod; an absent filter is not added to
 * the WHERE clause (dynamic SQL is built with a fixed clause list + a params
 * array — no string interpolation of user input, so no injection surface). The
 * query is parameterised raw SQL via `runQuery`, mirroring the gateway's other
 * read paths (no entity class on the hot path).
 *
 * `detail` is jsonb; pg returns it parsed, so it is forwarded verbatim.
 *
 * Auth: none — the gateway runs open (local-machine service). The audit
 * trail names actors and targets, meant for the local operator only.
 *
 * Standard envelope (CLAUDE.md API convention): { success, data?, error? }.
 */

export const auditRoutes = new Hono()

const log = createLogger({ svc: 'gateway:audit' })

/** Standard envelope helpers (same shape as the rest of the gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const querySchema = z.object({
  actorType: z.enum(['user', 'system']).optional(),
  actorId: z.string().max(256).optional(),
  action: z.string().max(128).optional(),
  // 与迁移 1720000015000 的 CHECK 对齐 —— 此前缺 workflow/agent/chat，
  // 写得进审计却查不出来（?targetType=workflow 直接 400）。
  targetType: z
    .enum(['token', 'pipeline_version', 'llm_provider', 'workflow', 'agent', 'chat'])
    .optional(),
  targetId: z.string().max(256).optional(),
  runId: z.string().max(128).optional(),
  workspaceId: z.string().uuid().optional(),
  // Caps pagination so a bare `GET /api/v1/audit` can't pull the whole table.
  // 200 is a generous page for an audit browse; `before` cursor walks older.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Cursor: created_at (RFC3339) of the oldest row on the current page. Rows
  // are ordered newest-first, so `before` fetches the page older than the
  // cursor. Optional → first page.
  before: z.string().datetime().optional(),
})

/** Row shape returned by the audit query (snake_case from pg → camelCased). */
interface AuditRow {
  id: string
  actor_type: AuditActorType
  actor_id: string
  action: string
  target_type: AuditTargetType
  target_id: string
  run_id: string | null
  workspace_id: string | null
  detail: unknown
  ip: string | null
  user_agent: string | null
  created_at: Date
}

/**
 * GET /api/v1/audit — list audit records, newest-first, filtered + paginated.
 *
 * Returns `{ items, nextBefore }`: `nextBefore` is the `created_at` of the
 * oldest item, to pass back as `?before=` for the next page. `null` when the
 * page is the last (fewer than `limit` rows returned). A caller can also detect
 * exhaustion by `items.length < limit`.
 *
 * The audit trail names actors + targets — meant for the local operator.
 */
auditRoutes.get('/', async (c) => {
  const parsed = querySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  // Build a fixed-clause WHERE with a params array. Each filter adds
  // `AND col = $n`; the cursor adds `AND created_at < $n`. No user input is
  // interpolated into the SQL string — only parameter placeholders — so there
  // is no injection surface even though the clause set is dynamic.
  const clauses: string[] = []
  const params: unknown[] = []
  if (q.actorType) {
    params.push(q.actorType)
    clauses.push(`actor_type = $${params.length}`)
  }
  if (q.actorId) {
    params.push(q.actorId)
    clauses.push(`actor_id = $${params.length}`)
  }
  if (q.action) {
    params.push(q.action)
    clauses.push(`action = $${params.length}`)
  }
  if (q.targetType) {
    params.push(q.targetType)
    clauses.push(`target_type = $${params.length}`)
  }
  if (q.targetId) {
    params.push(q.targetId)
    clauses.push(`target_id = $${params.length}`)
  }
  if (q.runId) {
    params.push(q.runId)
    clauses.push(`run_id = $${params.length}`)
  }
  if (q.workspaceId) {
    params.push(q.workspaceId)
    clauses.push(`workspace_id = $${params.length}`)
  }
  if (q.before) {
    params.push(q.before)
    clauses.push(`created_at < $${params.length}`)
  }
  // Fetch limit+1 to detect a next page without a second count query: if we get
  // limit+1 rows, a next page exists (and we trim to `limit` for the response).
  params.push(q.limit + 1)
  const limitParam = `$${params.length}`

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  let rows: AuditRow[]
  try {
    const { records } = await runQuery<AuditRow>(
      `SELECT id, actor_type, actor_id, action, target_type, target_id,
              run_id, workspace_id, detail, ip, user_agent, created_at
         FROM audit_log
         ${where}
         ORDER BY created_at DESC
         LIMIT ${limitParam}`,
      params,
    )
    rows = records
  } catch (err) {
    // The audit_log table may not exist yet on a fresh DB before migrations
    // run; surface a 502 (infrastructure) rather than a 500 with a raw pg
    // error (which could leak the connection string in the stack).
    log.error('audit query failed', { error: String(err) })
    return fail(c, 502, 'audit query failed')
  }

  const hasMore = rows.length > q.limit
  const items = hasMore ? rows.slice(0, q.limit) : rows
  // nextBefore = oldest item's created_at, only when a next page exists.
  const nextBefore = hasMore && items.length > 0 ? items[items.length - 1].created_at : null

  return ok(c, {
    items: items.map((r) => ({
      id: r.id,
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      runId: r.run_id,
      workspaceId: r.workspace_id,
      detail: r.detail,
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    })),
    nextBefore,
  })
})
