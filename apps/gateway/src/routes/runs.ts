/**
 * 跨 Flow 运行历史（PRD F5，docs/prd-workflow-first.md）。
 *
 * `GET /api/v1/runs?limit&status&flowId` —— Workflow-First IA 的运行历史页
 * 数据源：runs 表按时间倒序，LEFT JOIN flows 取名字；失败原因摘要列从
 * run_node_spans 聚合（首个 failed 节点的 error 截断 160 字）。chat_id
 * 非空 → 触发源 chat，否则 canvas/API。
 */
import { Hono } from 'hono'
import { createLogger } from '@dagents/shared'
import { listRunsHistory, summarizeRunsByFlow, type RunHistoryRow } from '../repositories/runs.repo.js'
import { ok, fail, UUID_RE } from '../lib/http.js'

const log = createLogger({ svc: 'gateway:runs' })

export const runsRoutes = new Hono()


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

/**
 * 运行输入全文（2026-09-08 可操作终端 §4.2）：重跑（⬆ 语义）的预填数据源
 * —— inputPreview 只够列表展示（80 字）。保险丝 8k 字符：防病态大输入
 * 撑爆列表载荷；正常用户输入远低于此。
 */
function extractInputFull(input: unknown): string | null {
  const s =
    typeof input === 'string'
      ? input
      : input && typeof input === 'object'
        ? (input as { input?: unknown }).input
        : null
  return typeof s === 'string' && s.length > 0 ? s.slice(0, 8_000) : null
}

runsRoutes.get('/', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50
  const status = c.req.query('status')
  const flowId = c.req.query('flowId')

  try {
    const records: RunHistoryRow[] = await listRunsHistory({
      status: status && ['completed', 'failed', 'cancelled', 'running'].includes(status) ? status : undefined,
      flowId: flowId && UUID_RE.test(flowId) ? flowId : undefined,
      limit,
    })

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
        input: extractInputFull(r.input),
        error: r.first_error,
        directoryId: r.directory_id ?? null,
        createdAt: r.created_at,
      })),
    )
  } catch (err) {
    // err.message 可能携带连接串/表名等内部细节 —— 日志留全文，回包只给类别（2026-09-17 评审修复）
    log.error('runs list query failed', { error: err instanceof Error ? err.message : String(err) })
    return fail(c, 500, '运行历史查询失败')
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
  const flowIds = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))].slice(0, 200)
  if (flowIds.length === 0) return ok(c, { summaries: [] })

  try {
    const records = await summarizeRunsByFlow(flowIds)
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
    log.error('runs summary query failed', { error: err instanceof Error ? err.message : String(err) })
    return fail(c, 500, '运行摘要查询失败')
  }
})
