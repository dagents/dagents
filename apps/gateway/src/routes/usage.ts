/**
 * Billing / usage summary API（方案 D / AD-3）：`usage_events` 的只读聚合面。
 *
 * `GET /api/v1/usage/summary?days=30` —— 账单页唯一数据源。三条执行路径
 * （chat / workflow_run / dispatch_task）终态各写一条 usage_events，本路由
 * 只做聚合读取（totals / byDay / byAgent / byFlow，SQL 在
 * repositories/usage-events.repo.ts），不复算价格。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import {
  getUsageTotals,
  getUsageByDay,
  getUsageByAgent,
  getUsageByFlow,
} from '../repositories/usage-events.repo.js'
import { ok, fail } from '../lib/http.js'

export const usageRoutes = new Hono()

const log = createLogger({ svc: 'gateway:usage' })


const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
})

usageRoutes.get('/summary', async (c) => {
  const parsed = summaryQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const { days } = parsed.data

  try {
    // 1. Totals: cost / events / tokens（priced 与 unpriced 分列）。
    const totalRows = await getUsageTotals(days)

    // 2. By day（账单页条形图；按会话时区取日界）。
    const byDayRows = await getUsageByDay(days)

    // 3. By agent（仅 chat 路径带 agent_id；workflow/dispatch 花费走 byFlow）。
    const byAgentRows = await getUsageByAgent(days)

    // 4. By flow（usage_events.flow_id 是 TEXT，flows.id 是 UUID —— 转文本对齐）。
    const byFlowRows = await getUsageByFlow(days)

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
