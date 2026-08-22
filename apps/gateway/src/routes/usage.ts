/**
 * Billing / usage summary API（方案 D / AD-3）：`usage_events` 的只读聚合面。
 *
 * `GET /api/v1/usage/summary?days=30` —— 账单页唯一数据源。三条执行路径
 * （chat / workflow_run / dispatch_task）终态各写一条 usage_events，本路由
 * 只做 SQL 聚合（totals / byDay / byAgent / byFlow），不复算价格。
 *
 * 设计要点：
 *   - token 求和兼容两种 usage 形状（contracts `inputTokens/outputTokens`
 *     与 workflow `prompt_tokens/completion_tokens`）—— 同一事件只用其中
 *     一种，两个 COALESCE 相加不会重复计数。
 *   - `cost` 为 NUMERIC(18,6)（pg driver 返回字符串），SQL 内 ::float8 出参。
 *   - `unpricedTokens` 单列「单价未知」的 token（priced=false，价格表更新
 *     后可回算重定价）—— 「不造假」原则的读侧表达。
 *   - agent/flow 名字 LEFT JOIN 取（usage_events 无外键，删掉的 agent/flow
 *     置 null，不丢账）。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

export const usageRoutes = new Hono()

const log = createLogger({ svc: 'gateway:usage' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
})

/**
 * Token-sum SQL fragment over the `usage` jsonb — tolerates both usage shapes
 * (`inputTokens`/`prompt_tokens` for input, `outputTokens`/`completion_tokens`
 * for output). Values are written by our own `recordUsageEvent` writer, so
 * they are always JSON numbers.
 */
const TOKENS_SQL = `(
  COALESCE((u.usage->>'inputTokens')::numeric, 0) +
  COALESCE((u.usage->>'prompt_tokens')::numeric, 0) +
  COALESCE((u.usage->>'outputTokens')::numeric, 0) +
  COALESCE((u.usage->>'completion_tokens')::numeric, 0)
)`

usageRoutes.get('/summary', async (c) => {
  const parsed = summaryQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const { days } = parsed.data

  try {
    // 1. Totals: cost / events / tokens（priced 与 unpriced 分列）。
    const { records: totalRows } = await runQuery<{
      cost: number
      tokens: number
      unpricedTokens: number
      events: number
    }>(
      `SELECT
         COALESCE(SUM(u.cost), 0)::float8 AS cost,
         COALESCE(SUM(CASE WHEN u.priced THEN ${TOKENS_SQL} ELSE 0 END), 0)::float8 AS tokens,
         COALESCE(SUM(CASE WHEN NOT u.priced THEN ${TOKENS_SQL} ELSE 0 END), 0)::float8 AS "unpricedTokens",
         COUNT(*)::int AS events
       FROM usage_events u
       WHERE u.created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [days],
    )

    // 2. By day（账单页条形图；按会话时区取日界）。
    const { records: byDayRows } = await runQuery<{ date: string; cost: number; tokens: number }>(
      `SELECT
         to_char(u.created_at, 'YYYY-MM-DD') AS date,
         COALESCE(SUM(u.cost), 0)::float8 AS cost,
         COALESCE(SUM(${TOKENS_SQL}), 0)::float8 AS tokens
       FROM usage_events u
       WHERE u.created_at >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY 1
       ORDER BY 1 ASC`,
      [days],
    )

    // 3. By agent（仅 chat 路径带 agent_id；workflow/dispatch 花费走 byFlow）。
    // `priced` = 该 agent 全部事件都已计价（BOOL_OR）。
    const { records: byAgentRows } = await runQuery<{
      agentId: string
      agentName: string | null
      cost: number
      tokens: number
      priced: boolean
    }>(
      `SELECT
         u.agent_id AS "agentId",
         a.name AS "agentName",
         COALESCE(SUM(u.cost), 0)::float8 AS cost,
         COALESCE(SUM(${TOKENS_SQL}), 0)::float8 AS tokens,
         BOOL_OR(u.priced) AS priced
       FROM usage_events u
       LEFT JOIN agents a ON a.id = u.agent_id
       WHERE u.created_at >= NOW() - ($1::int * INTERVAL '1 day')
         AND u.agent_id IS NOT NULL
       GROUP BY u.agent_id, a.name
       ORDER BY cost DESC`,
      [days],
    )

    // 4. By flow（usage_events.flow_id 是 TEXT，flows.id 是 UUID —— 转文本对齐）。
    const { records: byFlowRows } = await runQuery<{
      flowId: string
      flowName: string | null
      cost: number
      tokens: number
    }>(
      `SELECT
         u.flow_id AS "flowId",
         f.name AS "flowName",
         COALESCE(SUM(u.cost), 0)::float8 AS cost,
         COALESCE(SUM(${TOKENS_SQL}), 0)::float8 AS tokens
       FROM usage_events u
       LEFT JOIN flows f ON f.id::text = u.flow_id
       WHERE u.created_at >= NOW() - ($1::int * INTERVAL '1 day')
         AND u.flow_id IS NOT NULL
       GROUP BY u.flow_id, f.name
       ORDER BY cost DESC`,
      [days],
    )

    const totals = totalRows[0] ?? { cost: 0, tokens: 0, unpricedTokens: 0, events: 0 }
    return ok(c, {
      totals: {
        cost: totals.cost,
        tokens: totals.tokens,
        unpricedTokens: totals.unpricedTokens,
        events: totals.events,
      },
      byDay: byDayRows,
      byAgent: byAgentRows,
      byFlow: byFlowRows,
    })
  } catch (err) {
    log.error('usage summary query failed', { days, error: String(err) })
    return fail(c, 502, 'usage summary failed')
  }
})
