/**
 * usage-events.repo.ts — `usage_events` 表的只读聚合面。
 *
 * usage_events：账单真相源（三条执行路径 chat / workflow_run / dispatch_task
 * 终态各写一条；写侧在 usage-events.ts 服务）。本层只做 SQL 聚合
 * （totals / byDay / byAgent / byFlow），不复算价格 —— token 求和兼容
 * contracts 与 workflow 两种 usage 命名，cost 为 NUMERIC 出参转 float8，
 * unpricedTokens 单列「单价未知」的 token（priced=false，价格表更新后可
 * 回算重定价）—— 「不造假」原则的读侧表达。agent/flow 名字 LEFT JOIN 取
 * （无外键，删掉的 agent/flow 置 null，不丢账）。
 */
import { runQuery } from '@dagents/db'

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

/** 1. Totals: cost / events / tokens（priced 与 unpriced 分列）。 */
export async function getUsageTotals(days: number): Promise<{
  cost: number
  tokens: number
  unpricedTokens: number
  events: number
}[]> {
  const { records } = await runQuery<{
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
  return records
}

/** 2. By day（账单页条形图；按会话时区取日界）。 */
export async function getUsageByDay(days: number): Promise<Array<{ date: string; cost: number; tokens: number }>> {
  const { records } = await runQuery<{ date: string; cost: number; tokens: number }>(
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
  return records
}

/** 3. By agent（仅 chat 路径带 agent_id；priced = BOOL_OR 全事件已计价）。 */
export async function getUsageByAgent(days: number): Promise<Array<{
  agentId: string
  agentName: string | null
  cost: number
  tokens: number
  priced: boolean
}>> {
  const { records } = await runQuery<{
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
  return records
}

/** 4. By flow（usage_events.flow_id 是 TEXT，flows.id 是 UUID —— 转文本对齐）。 */
export async function getUsageByFlow(days: number): Promise<Array<{
  flowId: string
  flowName: string | null
  cost: number
  tokens: number
}>> {
  const { records } = await runQuery<{
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
  return records
}
