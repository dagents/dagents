/**
 * team-overview.ts — 公司作战室（Team Room）客户端领域模型（方向 A/D）。
 *
 * 域模型 + 纯投影（fleet-stats.ts 同款姿势：fetch 薄封装 + 无 React 的
 * 纯函数，jsdom/node 均可单测）：
 *   - `deriveTeamFeed`：相邻两帧 overview 的节点状态迁移 → 活动墙事件流
 *     （MVP 不做 SSE 扇出，轮询 diff 即「直播」）
 *   - `deriveCompanyTimeline`：24h run 谱系 + span → 公司时间线泳道甘特
 *     （方向 D：多 run 拼接、lane 按 agent 身份聚合——研究 §4-D 的落地）
 *   - `deriveRoster`：roster + 运行中节点 → 成员值班卡（谁在干活）
 */

import { apiFetch } from '@/lib/api'

// ─── wire 模型（gateway GET /api/v1/team/overview 的忠实投影） ─────────

export interface TeamKpis {
  runningRuns: number
  activeAgents: number
  runsCompleted: number
  runsFailed: number
  goalsActive: number
  goalsAchievedToday: number
  cost: number
  tokens: number
  unpricedTokens: number
}

export interface TeamNode {
  nodeId: string
  label: string
  nodeType: string | null
  status: string
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  cost: number | null
  error: string | null
  agentId: string | null
  agentName: string | null
}

export interface TeamRun {
  runId: string
  flowId: string | null
  flowName: string | null
  status: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  cost: number | null
  directoryId: string | null
  chatId: string | null
  goalId: string | null
  nodes: TeamNode[]
}

export interface BlackboardEntryDto {
  name: string
  relPath: string
  mtime: string | null
  size: number
}

export interface BlackboardDto {
  root: string
  exists: boolean
  boardMd: string | null
  boardMtime: string | null
  knowledge: BlackboardEntryDto[]
  handoff: BlackboardEntryDto[]
  directoryId?: string
  directoryName?: string | null
}

export interface TeamOverview {
  generatedAt: string
  windowHours: number
  kpis: TeamKpis
  running: TeamRun[]
  recentRuns: TeamRun[]
  roster: Array<{ agentId: string; name: string; kind: string }>
  blackboard: BlackboardDto | null
  blackboardDirectoryName: string | null
}

/** GET /api/team/overview（BFF 代理）；`cache: 'no-store'` 保持作战室实时性。 */
export async function fetchTeamOverview(
  directoryId?: string,
  signal?: AbortSignal,
): Promise<TeamOverview> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const qs = directoryId ? `?directoryId=${encodeURIComponent(directoryId)}` : ''
  return apiFetch<TeamOverview>(`/api/team/overview${qs}`, { method: 'GET', signal }, 'team overview')
}

// ─── 活动墙：帧 diff → 事件流（纯函数） ───────────────────────────────

export interface TeamFeedEvent {
  key: string
  at: string
  kind: 'started' | 'finished' | 'failed'
  agentName: string
  runId: string
  flowId: string | null
  flowName: string | null
  nodeLabel: string
  durationMs: number | null
  error: string | null
}

const MAX_FEED = 200

/**
 * 相邻两帧 diff：节点状态迁移即事件（idle→running = started；
 * running→done = finished；→fail/failed = failed）。新 run 出现也算
 * started（flow 维度）。返回最新在前的事件数组（上限 MAX_FEED 条）。
 */
export function deriveTeamFeed(
  prev: TeamOverview | null,
  next: TeamOverview,
): TeamFeedEvent[] {
  const events: TeamFeedEvent[] = []
  const prevNodes = new Map<string, string>()
  if (prev) {
    for (const r of [...prev.running, ...prev.recentRuns]) {
      for (const n of r.nodes) prevNodes.set(`${r.runId}:${n.nodeId}`, n.status)
    }
  }

  const consider = (r: TeamRun) => {
    for (const n of r.nodes) {
      const key = `${r.runId}:${n.nodeId}`
      const before = prevNodes.get(key)
      if (before === n.status) continue
      let kind: TeamFeedEvent['kind'] | null = null
      if (n.status === 'running' && before !== 'running') kind = 'started'
      else if ((n.status === 'done' || n.status === 'FINISHED') && before !== n.status) kind = 'finished'
      else if (n.status === 'fail' || n.status === 'failed' || n.status === 'ERROR') kind = 'failed'
      if (!kind) continue
      events.push({
        key,
        at: (kind === 'started' ? n.startedAt : n.endedAt) ?? next.generatedAt,
        kind,
        agentName: n.agentName ?? n.label,
        runId: r.runId,
        flowId: r.flowId,
        flowName: r.flowName,
        nodeLabel: n.label,
        durationMs: n.durationMs,
        error: n.error,
      })
    }
  }
  for (const r of next.running) consider(r)
  // 24h 谱系里 running 之外的 run 只有刚终态的才值得上墙（prev 帧在即可 diff 出）
  for (const r of next.recentRuns) consider(r)

  events.sort((a, b) => b.at.localeCompare(a.at))
  return events.slice(0, MAX_FEED)
}

// ─── 公司时间线：多 run 泳道甘特（纯函数，方向 D） ────────────────────

export interface TimelineLane {
  /** 泳道主（agent 名或节点标签）。 */
  label: string
  /** 归属 agent 的 id（非 agent 节点为 null）。 */
  agentId: string | null
  segments: Array<{
    runId: string
    flowName: string | null
    label: string
    status: string
    startMs: number
    endMs: number | null
  }>
}

export interface CompanyTimeline {
  lanes: TimelineLane[]
  minMs: number
  maxMs: number
}

function ms(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** 没有有效时间的 span 垫到其 run 起点（诚实画法：至少知道在哪个 run 里）。 */
function segmentTime(
  n: TeamNode,
  runStart: number | null,
): { startMs: number; endMs: number | null } {
  const s = ms(n.startedAt) ?? runStart ?? Date.now()
  const e = ms(n.endedAt)
  return { startMs: s, endMs: e != null && e >= s ? e : n.status === 'running' ? null : s }
}

/**
 * 24h run 谱系 → 按「agent 身份」聚合的公司时间线泳道。
 * 同一 agent 跨 run/跨节点共享一条 lane（研究 §3-D1：泳道单位从节点 id
 * 透视到 agent 身份）；非 agent 节点各占一条 lane。时间窗取全部 span 的
 * min/max；无 span 返回空时间线（界面渲染空态）。
 */
export function deriveCompanyTimeline(
  runs: TeamRun[],
  nowMs: number = Date.now(),
): CompanyTimeline {
  const laneByKey = new Map<string, TimelineLane>()
  let minMs = Number.POSITIVE_INFINITY
  let maxMs = Number.NEGATIVE_INFINITY

  for (const r of runs) {
    const runStart = ms(r.startedAt)
    for (const n of r.nodes) {
      const laneKey = n.agentId ?? `node:${r.runId}:${n.nodeId}`
      const label = n.agentName ?? n.label
      const lane = laneByKey.get(laneKey) ?? { label, agentId: n.agentId, segments: [] }
      if (!laneByKey.has(laneKey)) laneByKey.set(laneKey, lane)
      const t = segmentTime(n, runStart)
      lane.segments.push({
        runId: r.runId,
        flowName: r.flowName,
        label: n.label,
        status: n.status,
        startMs: t.startMs,
        endMs: t.endMs,
      })
      minMs = Math.min(minMs, t.startMs)
      maxMs = Math.max(maxMs, t.endMs ?? Math.max(nowMs, t.startMs))
    }
  }

  if (!Number.isFinite(minMs)) return { lanes: [], minMs: 0, maxMs: 0 }
  const lanes = [...laneByKey.values()]
  // 活跃 lane 在前（有 running 段），其余按最近活动降序
  const lastActive = (l: TimelineLane) =>
    Math.max(...l.segments.map((s) => s.endMs ?? nowMs))
  lanes.sort(
    (a, b) =>
      Number(b.segments.some((s) => s.status === 'running')) -
        Number(a.segments.some((s) => s.status === 'running')) || lastActive(b) - lastActive(a),
  )
  return { lanes, minMs, maxMs }
}

// ─── 成员值班卡（纯函数） ─────────────────────────────────────────────

export interface RosterCard {
  agentId: string
  name: string
  kind: string
  /** 当前是否有 running 节点。 */
  busy: boolean
  /** 正在跑的节点描述（run·节点），idle 为 null。 */
  currentTask: string | null
  currentRunId: string | null
  /** 24h 内参与的节点数（有 agent 身份的 span）。 */
  todayNodes: number
}

export function deriveRoster(overview: TeamOverview): RosterCard[] {
  const cards = new Map<string, RosterCard>()
  for (const a of overview.roster) {
    cards.set(a.agentId, {
      agentId: a.agentId,
      name: a.name,
      kind: a.kind,
      busy: false,
      currentTask: null,
      currentRunId: null,
      todayNodes: 0,
    })
  }
  for (const r of [...overview.running, ...overview.recentRuns]) {
    for (const n of r.nodes) {
      if (!n.agentId) continue
      const card = cards.get(n.agentId)
      if (!card) continue
      card.todayNodes += 1
      if (n.status === 'running') {
        card.busy = true
        card.currentTask = n.label
        card.currentRunId = r.runId
      }
    }
  }
  return [...cards.values()].sort(
    (a, b) => Number(b.busy) - Number(a.busy) || b.todayNodes - a.todayNodes || a.name.localeCompare(b.name),
  )
}

// ─── 格式化（薄） ─────────────────────────────────────────────────────

export function formatUsd(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '<$0.01'
  return `$${v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')}`
}

export function formatTokensCompact(v: number): string {
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0)}K`
  return `${(v / 1_000_000).toFixed(1)}M`
}
