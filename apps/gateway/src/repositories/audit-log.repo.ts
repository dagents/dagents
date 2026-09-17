/**
 * audit-log.repo.ts — `audit_log` 表的读取面。
 *
 * audit_log：审计轨迹（写侧在 audit.ts 服务，token 路由 / 工作流变更 /
 * provider 变更 fire-and-forget 落库）。本层是操作员读侧：按 actor/action/
 * target/run 过滤 + created_at 游标分页（limit+1 探下一页），newest-first。
 * 过滤子句集合动态但全部走参数占位 —— 无用户输入拼进 SQL 文本。
 */
import { runQuery } from '@dagents/db'
import type { AuditActorType, AuditTargetType } from '@dagents/db'

/** Row shape returned by the audit query (snake_case from pg → camelCased). */
export interface AuditRow {
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

export interface AuditListFilters {
  actorType?: string
  actorId?: string
  action?: string
  targetType?: string
  targetId?: string
  runId?: string
  workspaceId?: string
  /** 游标：当前页最旧一行的 created_at（RFC3339）。缺省 = 第一页。 */
  before?: string
  limit: number
}

/**
 * 审计记录列表（newest-first）。固定子句清单 + params 数组构建动态 WHERE
 * —— 每个过滤器加一条 `AND col = $n`，游标加 `AND created_at < $n`；limit
 * 额外取 1 行供调用方探测下一页（拿到 limit+1 行 → 有下一页，自行裁剪）。
 */
export async function listAuditRecords(filters: AuditListFilters): Promise<AuditRow[]> {
  // Build a fixed-clause WHERE with a params array. Each filter adds
  // `AND col = $n`; the cursor adds `AND created_at < $n`. No user input is
  // interpolated into the SQL string — only parameter placeholders — so there
  // is no injection surface even though the clause set is dynamic.
  const clauses: string[] = []
  const params: unknown[] = []
  if (filters.actorType) {
    params.push(filters.actorType)
    clauses.push(`actor_type = $${params.length}`)
  }
  if (filters.actorId) {
    params.push(filters.actorId)
    clauses.push(`actor_id = $${params.length}`)
  }
  if (filters.action) {
    params.push(filters.action)
    clauses.push(`action = $${params.length}`)
  }
  if (filters.targetType) {
    params.push(filters.targetType)
    clauses.push(`target_type = $${params.length}`)
  }
  if (filters.targetId) {
    params.push(filters.targetId)
    clauses.push(`target_id = $${params.length}`)
  }
  if (filters.runId) {
    params.push(filters.runId)
    clauses.push(`run_id = $${params.length}`)
  }
  if (filters.workspaceId) {
    params.push(filters.workspaceId)
    clauses.push(`workspace_id = $${params.length}`)
  }
  if (filters.before) {
    params.push(filters.before)
    clauses.push(`created_at < $${params.length}`)
  }
  // Fetch limit+1 to detect a next page without a second count query: if we get
  // limit+1 rows, a next page exists (and we trim to `limit` for the response).
  params.push(filters.limit + 1)
  const limitParam = `$${params.length}`

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const { records } = await runQuery<AuditRow>(
    `SELECT id, actor_type, actor_id, action, target_type, target_id,
            run_id, workspace_id, detail, ip, user_agent, created_at
       FROM audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
    params,
  )
  return records
}
