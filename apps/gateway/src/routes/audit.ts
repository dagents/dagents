import { Hono } from 'hono'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import { listAuditRecords, type AuditRow } from '../repositories/audit-log.repo.js'
import { ok, fail } from '../lib/http.js'

/**
 * `GET /api/v1/audit` — audit log query endpoint (plan M6.6 / spec §1.4 职责 #5).
 *
 * The audit trail is written fire-and-forget by the token routes + the
 * scheduler's version-lock path; this endpoint is the read side — an operator
 * (or a future console "审计" page) lists audit records filtered by actor /
 * action / target / run_id, newest-first, paginated.
 *
 * Filters are all optional + validated by zod; an absent filter is not added to
 * the WHERE clause（动态子句在 repositories/audit-log.repo.ts 内以固定子句
 * 清单 + params 数组构建 —— 无用户输入拼进 SQL 文本，无注入面）。
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

  let rows: AuditRow[]
  try {
    rows = await listAuditRecords({
      actorType: q.actorType,
      actorId: q.actorId,
      action: q.action,
      targetType: q.targetType,
      targetId: q.targetId,
      runId: q.runId,
      workspaceId: q.workspaceId,
      before: q.before,
      limit: q.limit,
    })
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
