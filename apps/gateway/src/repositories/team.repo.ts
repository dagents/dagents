/**
 * team.repo.ts — 公司作战室（Team Room）聚合数据层（方向 A，2026-11-10）。
 *
 * 一次给齐 `/api/v1/team/overview` 的五块数据：
 *   1. KPI（运行中 run / 活跃 agent / 24h 终态 / 24h 成本·token）
 *   2. 运行中 run 及其节点 span（活动墙 + 值班卡数据源）
 *   3. 24h 内 run 谱系 + span（公司时间线 / 多 run 对比数据源，方向 D）
 *   4. agent 花名册（agents 表 + 由 span 反推的今日活动）
 *   5. 活跃 goal 计数（方向 C，goals 表缺失时诚实 0）
 *
 * agent 身份解析：span 只有 node_id——`flows.flow_data` 里 platformAgent
 * 节点携带 `agentId`，这里把「flow → nodeId → agentId」做成查找表再对
 * agents 表取名。非 Agent 节点（llm/condition/…）无 agent 身份，如实跳过。
 */
import { runQuery } from '@dagents/db'

/** 一个 run 行（作战室精简版：不带 input/output 大字段）。 */
export interface TeamRunRow {
  id: string
  status: string
  created_at: Date
  finished_at: Date | null
  duration_ms: number | null
  cost: string | number | null
  flow_id: string | null
  flow_name: string | null
  directory_id: string | null
  chat_id: string | null
  goal_id: string | null
}

/** 作战室 span 精简行。 */
export interface TeamSpanRow {
  run_id: string
  node_id: string
  node_label: string | null
  node_type: string | null
  status: string
  started_at: Date | string | null
  finished_at: Date | string | null
  duration_ms: number | null
  cost: string | number | null
  tokens: unknown
  error: string | null
}

const RUN_COLUMNS = `r.id, r.status, r.created_at, r.finished_at, r.duration_ms, r.cost,
  r.pipeline_id AS flow_id, f.name AS flow_name,
  r.directory_id, r.chat_id, r.goal_id`

/** 运行中的 run（全量，限 20——并发闸 8 之下这已是上限的 2.5 倍余量）。 */
export async function listRunningRunsForTeam(): Promise<TeamRunRow[]> {
  const { records } = await runQuery<TeamRunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM runs r LEFT JOIN flows f ON f.id::text = r.pipeline_id::text
      WHERE r.status = 'running'
      ORDER BY r.created_at DESC
      LIMIT 20`,
  )
  return records
}

/** 近 windowHours 小时的 run 谱系（公司时间线数据源；running 也含，时间线要画在跑的）。 */
export async function listRecentRunsForTeam(windowHours: number): Promise<TeamRunRow[]> {
  const { records } = await runQuery<TeamRunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM runs r LEFT JOIN flows f ON f.id::text = r.pipeline_id::text
      WHERE r.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY r.created_at DESC
      LIMIT 100`,
    [windowHours],
  )
  return records
}

/** 一批 run 的全部节点 span（一次查询；run 级聚合在 JS 侧做，量级 ≤100×节点数）。 */
export async function listSpansForRuns(runIds: string[]): Promise<TeamSpanRow[]> {
  if (runIds.length === 0) return []
  const { records } = await runQuery<TeamSpanRow>(
    `SELECT run_id, node_id, node_label, node_type, status, started_at, finished_at,
            duration_ms, cost, tokens, error
       FROM run_node_spans
      WHERE run_id = ANY($1::uuid[])
      ORDER BY COALESCE(started_at, created_at) ASC`,
    [runIds],
  )
  return records
}

/** 24h 终态计数（KPI：今日完成/失败）。 */
export async function countRunsByStatus(
  windowHours: number,
): Promise<Record<string, number>> {
  const { records } = await runQuery<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n
       FROM runs
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        AND status IN ('completed', 'failed', 'cancelled', 'partial_success', 'budget_exceeded')
      GROUP BY status`,
    [windowHours],
  )
  const out: Record<string, number> = {}
  for (const r of records) out[r.status] = Number(r.n)
  return out
}

export interface FlowNodeAgentRow {
  flow_id: string
  node_id: string
  agent_id: string
}

/** flow_data → platformAgent 节点的 agentId 查找表（jsonb 侧解析，非 JS 全量拉取）。 */
export async function listFlowNodeAgents(flowIds: string[]): Promise<FlowNodeAgentRow[]> {
  if (flowIds.length === 0) return []
  const { records } = await runQuery<FlowNodeAgentRow>(
    `SELECT f.id::text AS flow_id,
            (n->>'id') AS node_id,
            COALESCE(n->'data'->'inputs'->>'agentId', n->'data'->>'agentId') AS agent_id
       FROM flows f
       CROSS JOIN LATERAL jsonb_array_elements(f.flow_data->'nodes') AS n
      WHERE f.id::text = ANY($1::text[])
        AND COALESCE(n->'data'->'inputs'->>'agentId', n->'data'->>'agentId') IS NOT NULL`,
    [flowIds],
  )
  return records.filter((r) => r.agent_id)
}

/** agents 表花名册（已启用 agent 的身份 + 类型）。 */
export async function listAgentRoster(): Promise<
  Array<{ id: string; name: string; kind: string }>
> {
  const { records } = await runQuery<{ id: string; name: string; kind: string }>(
    `SELECT id, name, kind FROM agents ORDER BY name ASC LIMIT 200`,
  )
  return records
}

/** goals 活跃计数（goals 表尚不存在时由调用方降级为 0——迁移先后顺序容错）。 */
export async function countActiveGoals(): Promise<{ active: number; achieved: number }> {
  const { records } = await runQuery<{ active: number; achieved: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('active', 'awaiting_eval'))::int AS active,
       COUNT(*) FILTER (WHERE status = 'achieved' AND updated_at >= NOW() - INTERVAL '1 day')::int AS achieved
     FROM goals`,
  )
  return records[0] ?? { active: 0, achieved: 0 }
}
