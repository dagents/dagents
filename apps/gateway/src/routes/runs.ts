/**
 * 跨 Flow 运行历史（PRD F5，docs/prd-workflow-first.md）。
 *
 * `GET /api/v1/runs?limit&status&flowId` —— Workflow-First IA 的运行历史页
 * 数据源：runs 表按时间倒序，LEFT JOIN flows 取名字；失败原因摘要列从
 * run_node_spans 聚合（首个 failed 节点的 error 截断 160 字）。chat_id
 * 非空 → 触发源 chat，否则 canvas/API。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { runQuery } from '@dagents/db'

export const runsRoutes = new Hono()

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (c: Context, status: ContentfulStatusCode, error: string) =>
  c.json({ success: false, error }, status)

interface RunListRow {
  id: string
  flow_id: string | null
  flow_name: string | null
  status: string
  started_at: Date | null
  finished_at: Date | null
  duration_ms: number | null
  input: unknown
  chat_id: string | null
  created_at: Date
  first_error: string | null
}

runsRoutes.get('/', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50
  const status = c.req.query('status')
  const flowId = c.req.query('flowId')

  const where: string[] = []
  const params: unknown[] = []
  if (status && ['completed', 'failed', 'cancelled', 'running'].includes(status)) {
    params.push(status)
    where.push(`r.status = $${params.length}`)
  }
  if (flowId && /^[0-9a-f-]{36}$/i.test(flowId)) {
    params.push(flowId)
    where.push(`r.pipeline_id = $${params.length}`)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  try {
    params.push(limit)
    const limitIdx = params.length
    const { records } = await runQuery<RunListRow>(
      `SELECT r.id, r.pipeline_id AS flow_id, f.name AS flow_name,
              r.status, r.started_at, r.finished_at, r.duration_ms,
              r.input, r.chat_id, r.created_at,
              (SELECT left(s.error, 160) FROM run_node_spans s
                WHERE s.run_id = r.id AND s.status = 'failed' AND s.error IS NOT NULL
                ORDER BY s.started_at ASC LIMIT 1) AS first_error
         FROM runs r
         LEFT JOIN flows f ON f.id::text = r.pipeline_id
         ${whereSql}
        ORDER BY r.created_at DESC
        LIMIT $${limitIdx}`,
      params,
    )

    return ok(
      c,
      records.map((r) => ({
        runId: r.id,
        flowId: r.flow_id,
        flowName: r.flow_name,
        status: r.status,
        source: r.chat_id ? 'chat' : 'canvas',
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        durationMs: r.duration_ms,
        inputPreview:
          typeof r.input === 'string' ? r.input.slice(0, 80) : (r.input ?? null),
        error: r.first_error,
        createdAt: r.created_at,
      })),
    )
  } catch (err) {
    return fail(c, 500, `运行历史查询失败：${err instanceof Error ? err.message : String(err)}`)
  }
})
