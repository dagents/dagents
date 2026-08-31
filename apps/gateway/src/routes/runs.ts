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

/**
 * 输入预览提取：runs.input 是 JSONB —— 运行请求体常见形态
 * `{"input":"..."}`，直接透传对象会让消费端（FlowRunsPanel 等）显示
 * '—'。字符串 / `{input: string}` 都解出文本并截断；其余（null/复杂
 * 对象）返回 null。
 */
function extractInputPreview(input: unknown): string | null {
  if (typeof input === 'string') return input.slice(0, 80) || null
  if (input && typeof input === 'object') {
    const inner = (input as { input?: unknown }).input
    if (typeof inner === 'string' && inner.length > 0) return inner.slice(0, 80)
  }
  return null
}

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
        inputPreview: extractInputPreview(r.input),
        error: r.first_error,
        createdAt: r.created_at,
      })),
    )
  } catch (err) {
    return fail(c, 500, `运行历史查询失败：${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * POST /summary — 批量每-flow 运行摘要（PRD FR-04 / 决议 D5）。
 *
 * 列表页 35 张卡片逐卡 `?flowId=` 懒加载是 N+1；徽章数据（最近一次状态 /
 * 次数 / 最近时间）应该一次请求拉齐。DISTINCT ON 单查询取每流最新一条
 * run，次数用子查询聚合。body: `{ flowIds: string[] }`（≤200 个）。
 */
runsRoutes.post('/summary', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const rawIds = (body as { flowIds?: unknown })?.flowIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return fail(c, 400, 'flowIds must be a non-empty array')
  }
  const flowIds = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)))].slice(0, 200)
  if (flowIds.length === 0) return ok(c, { summaries: [] })

  try {
    const { records } = await runQuery<{
      flow_id: string
      latest_status: string | null
      latest_run_id: string | null
      latest_at: Date | null
      run_count: string | number
    }>(
      `SELECT r.pipeline_id AS flow_id,
              latest.status AS latest_status,
              latest.id AS latest_run_id,
              latest.created_at AS latest_at,
              COUNT(r.id)::text AS run_count
         FROM runs r
         LEFT JOIN LATERAL (
           SELECT id, status, created_at FROM runs s
            WHERE s.pipeline_id = r.pipeline_id
            ORDER BY s.created_at DESC LIMIT 1
         ) latest ON true
        WHERE r.pipeline_id = ANY($1::text[])
        GROUP BY r.pipeline_id, latest.id, latest.status, latest.created_at`,
      [flowIds],
    )
    const byFlow = new Map(
      records.map((r) => [
        r.flow_id,
        {
          flowId: r.flow_id,
          latestStatus: r.latest_status,
          latestRunId: r.latest_run_id,
          latestRunAt: r.latest_at,
          runCount: Number(r.run_count),
        },
      ]),
    )
    return ok(c, {
      summaries: flowIds.map((id) => byFlow.get(id) ?? { flowId: id, latestStatus: null, latestRunId: null, latestRunAt: null, runCount: 0 }),
    })
  } catch (err) {
    return fail(c, 500, `运行摘要查询失败：${err instanceof Error ? err.message : String(err)}`)
  }
})
