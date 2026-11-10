/**
 * `/api/v1/team/*` — 公司作战室（Team Room）聚合端点（方向 A，2026-11-10）。
 *
 * `GET /overview`：一次给齐作战室整屏数据（KPI / 运行中 run·节点 / 24h
 * run 谱系·span / agent 花名册 / goal 计数 / 可选黑板快照）。console 3s
 * 轮询本端点渲染整页；「活动墙」由前端对相邻两帧快照做 diff 派生（节点
 * 状态迁移即事件），MVP 不需要逐 token 的 SSE 扇出。
 *
 * 数据源全部现成（runs / run_node_spans / flows.flow_data / agents /
 * usage_events / goals），本路由只做组装与身份解析（node → agent）。
 */
import { Hono } from 'hono'
import { createLogger } from '@dagents/shared'
import { ok, fail } from '../lib/http.js'
import { UUID_RE } from '../lib/http.js'
import { getUsageTotals } from '../repositories/usage-events.repo.js'
import { getDirectoryById } from '../repositories/directories.repo.js'
import { readBlackboardSnapshot, BLACKBOARD_DIR } from '../lib/blackboard.js'
import {
  listRunningRunsForTeam,
  listRecentRunsForTeam,
  listSpansForRuns,
  countRunsByStatus,
  listFlowNodeAgents,
  listAgentRoster,
  countActiveGoals,
  type TeamRunRow,
  type TeamSpanRow,
} from '../repositories/team.repo.js'

export const teamRoutes = new Hono()

const log = createLogger({ svc: 'gateway:team' })

/** 24h 窗口（KPI 与时间线的默认视界）。 */
const WINDOW_HOURS = 24

interface AgentRef {
  agentId: string
  agentName: string | null
}

/**
 * node → agent 身份查找表：`flowId:nodeId` → agent 引用。
 * platformAgent 节点携带 agentId（jsonb 解析在 repo 侧），名字对 agents 表补齐。
 */
async function buildNodeAgentIndex(
  flowIds: string[],
): Promise<Map<string, AgentRef>> {
  const rows = await listFlowNodeAgents(flowIds)
  if (rows.length === 0) return new Map()
  const ids = [...new Set(rows.map((r) => r.agent_id))].filter((id) => UUID_RE.test(id))
  const names = new Map<string, string>()
  if (ids.length > 0) {
    const roster = await listAgentRoster()
    for (const a of roster) names.set(a.id, a.name)
  }
  const idx = new Map<string, AgentRef>()
  for (const r of rows) {
    idx.set(`${r.flow_id}:${r.node_id}`, {
      agentId: r.agent_id,
      agentName: names.get(r.agent_id) ?? null,
    })
  }
  return idx
}

function iso(v: Date | string | null): string | null {
  if (v == null) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

/** span → 作战室节点 DTO（带 agent 身份透视）。 */
function toNodeDto(s: TeamSpanRow, idx: Map<string, AgentRef>, flowId: string | null) {
  const ref = flowId ? idx.get(`${flowId}:${s.node_id}`) : undefined
  return {
    nodeId: s.node_id,
    label: s.node_label ?? s.node_id,
    nodeType: s.node_type,
    status: s.status,
    startedAt: iso(s.started_at),
    endedAt: iso(s.finished_at),
    durationMs: s.duration_ms,
    cost: s.cost == null ? null : Number(s.cost),
    error: s.error,
    agentId: ref?.agentId ?? null,
    agentName: ref?.agentName ?? null,
  }
}

teamRoutes.get('/overview', async (c) => {
  const directoryIdRaw = c.req.query('directoryId')
  const directoryId = directoryIdRaw && UUID_RE.test(directoryIdRaw) ? directoryIdRaw : null

  try {
    const [running, recent, statusCounts, usageTotals, roster] = await Promise.all([
      listRunningRunsForTeam(),
      listRecentRunsForTeam(WINDOW_HOURS),
      countRunsByStatus(WINDOW_HOURS),
      getUsageTotals(1),
      listAgentRoster(),
    ])

    // goals 计数容错：goals 表由同期迁移创建，旧库未迁移时诚实 0 而非 500
    let goals = { active: 0, achieved: 0 }
    try {
      goals = await countActiveGoals()
    } catch {
      // 未迁移/表缺失 —— KPI 显示 0，迁移后自动生效
    }

    // 身份解析：涉及到的 flow 全集（运行中 + 24h 谱系）
    const flowIds = [...new Set([...running, ...recent].map((r) => r.flow_id).filter(Boolean))] as string[]
    const nodeAgentIdx = await buildNodeAgentIndex(flowIds)

    // span 批量取（运行中 run 全量 + 谱系 run 的时间线用）
    const runIds = [...new Set([...running, ...recent].map((r) => r.id))]
    const spans = await listSpansForRuns(runIds)
    const spansByRun = new Map<string, TeamSpanRow[]>()
    for (const s of spans) {
      const list = spansByRun.get(s.run_id) ?? []
      list.push(s)
      spansByRun.set(s.run_id, list)
    }
    const flowById = new Map([...running, ...recent].map((r) => [r.id, r.flow_id]))

    const toRunDto = (r: TeamRunRow) => ({
      runId: r.id,
      flowId: r.flow_id,
      flowName: r.flow_name,
      status: r.status,
      startedAt: iso(r.created_at),
      finishedAt: iso(r.finished_at),
      durationMs: r.duration_ms,
      cost: r.cost == null ? null : Number(r.cost),
      directoryId: r.directory_id,
      chatId: r.chat_id,
      goalId: r.goal_id,
      nodes: (spansByRun.get(r.id) ?? []).map((s) => toNodeDto(s, nodeAgentIdx, flowById.get(r.id) ?? null)),
    })

    // KPI：活跃 agent = 运行中 run 的 span 里解析出的去重 agent
    const activeAgents = new Set<string>()
    for (const r of running) {
      for (const s of spansByRun.get(r.id) ?? []) {
        const ref = r.flow_id ? nodeAgentIdx.get(`${r.flow_id}:${s.node_id}`) : undefined
        if (ref && s.status === 'running') activeAgents.add(ref.agentId)
      }
    }

    // 黑板：显式 directoryId 优先；缺省用第一个运行中 run 的目录（「跟着团队走」）
    let blackboardDirId = directoryId
    if (!blackboardDirId) {
      blackboardDirId = running.find((r) => r.directory_id)?.directory_id ?? null
    }
    let blackboard: Record<string, unknown> | null = null
    let blackboardDirectoryName: string | null = null
    if (blackboardDirId) {
      try {
        const dir = await getDirectoryById(blackboardDirId)
        if (dir) {
          const snap = readBlackboardSnapshot(dir.path)
          blackboard = { ...snap, directoryId: blackboardDirId }
          blackboardDirectoryName = dir.name
        }
      } catch (err) {
        log.warn('team blackboard read failed', { error: String(err) })
      }
    }

    const totals = usageTotals[0] ?? { cost: 0, tokens: 0, unpricedTokens: 0, events: 0 }

    return ok(c, {
      generatedAt: new Date().toISOString(),
      windowHours: WINDOW_HOURS,
      kpis: {
        runningRuns: running.length,
        activeAgents: activeAgents.size,
        runsCompleted: statusCounts.completed ?? 0,
        runsFailed:
          (statusCounts.failed ?? 0) +
          (statusCounts.partial_success ?? 0) +
          (statusCounts.budget_exceeded ?? 0),
        goalsActive: goals.active,
        goalsAchievedToday: goals.achieved,
        cost: totals.cost,
        tokens: totals.tokens,
        unpricedTokens: totals.unpricedTokens,
      },
      running: running.map(toRunDto),
      recentRuns: recent.map(toRunDto),
      roster: roster.map((a) => ({ agentId: a.id, name: a.name, kind: a.kind })),
      blackboard,
      blackboardDirectoryName,
    })
  } catch (err) {
    log.error('team overview failed', { error: err instanceof Error ? err.message : String(err) })
    return fail(c, 500, 'team overview query failed')
  }
})

export { BLACKBOARD_DIR }
