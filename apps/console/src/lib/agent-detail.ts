/**
 * Agent-detail page domain model + pure derivations (v0.3-M4.1).
 *
 * The agent-detail page (apps/console/src/app/agents/[id]) renders the
 * design/agent-detail.html layout: a left `.inspector` (identity head + live
 * presence + 属性 rows + Skills chip rail + 当前任务) and a right `.overview`
 * whose 4 tabs (Activity / Instructions / Skills / Logs) swap via click +
 * ArrowLeft/Right/Home/End. The design reads its data from a static
 * `window.OD_AGENTS` fixture; the console binds to the live `AgentDetail`
 * (fetchAgentDetail) + `AgentLogLine[]` (fetchAgentLogs) the agents catalogue
 * already maps.
 *
 * This module owns the PURE mapping from that live payload to the page render
 * model — plus the 30-bucket activity sparkline derivation (design's
 * `buckets()` helper, but sourced from real task history instead of a static
 * spec). Pure = no network, no React, no `Date.now()` at module load: the "now"
 * timestamp is threaded in by the caller so derivations stay deterministic
 * under vitest (matching agents-catalog.test.ts). Kept separate from the view
 * so the derivations are unit-testable in the node environment.
 *
 * Backend-contract alignment (v0.3-M9.1 / 后端契约 1): the gateway's
 * `GET /api/v1/agents/:id` now returns design-aligned camelCase fields
 * (`model` / `owner` / `instructions` / `concurrency` / `summary` / `skills`
 * / `inputSchema` / `outputSchema`) at the top level alongside the snake_case
 * runtime aliases. `derivePageModel` reads the camelCase design fields with
 * fallbacks to the capability descriptor / `—` / `（未设置提示词）` for
 * dispatch-shaped rows that lack them, and derives what it can from the
 * runtime payload (runtime from kind+daemon, progress from status+elapsed,
 * activity from task-history day buckets, availability from the daemon
 * heartbeat).
 */

import { AGENT_KINDS, type AgentDetail, type AgentKind, type AgentLogLine, type AgentStatus } from './agents-catalog'

/** One day-bar in the 30-day activity sparkline (design `{total, ok, fail}`). */
export interface AgentActivityBucket {
  total: number
  ok: number
  fail: number
}

/** Design's detail-level presence (online/unstable/offline), derived from the
 *  daemon heartbeat state (`agent_daemons.status`). */
export type AgentAvailability = 'online' | 'unstable' | 'offline'

/** The render model the agent-detail page consumes — design's agent shape,
 *  normalized from the live `AgentDetail` payload. */
export interface AgentDetailPageModel {
  // identity head
  id: string
  name: string
  kind: AgentKind
  roles: string[]
  summary: string
  // live presence
  status: AgentStatus
  availability: AgentAvailability
  // inspector 属性 rows
  model: string
  runtime: string
  visibility: 'workspace' | 'public'
  owner: string
  createdAt: string
  concurrency: string
  // descriptor (Instructions / Skills tabs)
  instructions: string
  inputSchema: string
  outputSchema: string
  skills: string[]
  // 当前任务
  currentRun: string | null
  progress: number // 0–100
  elapsed: string
  // Logs tab — 区域与资源
  region: string
  daemon: string
  load: number // 0–100
  cost: string
  // activity (30-day)
  activity: AgentActivityBucket[] // length === 30
  runCount: number
  failCount: number
  // logs stream
  logs: AgentLogLine[]
}

const MS_PER_DAY = 86_400_000
const MS_PER_SEC = 1000
const MS_PER_MIN = 60 * MS_PER_SEC
export const ACTIVITY_BUCKET_COUNT = 30

/** Runtime label prefix per kind, shown in the detail inspector's 运行时 row.
 *  Derived from the shared {@link AGENT_KINDS} metadata (binary → runtime):
 *  CLI kinds use their binary (e.g. `claude`, `cursor-agent`), `prompt` is
 *  workflow-native, `remote` is remote. Built once at module load so the
 *  detail derivation stays a pure lookup. */
const KIND_RUNTIME_PREFIX: Record<AgentKind, string> = AGENT_KINDS.reduce(
  (acc, m) => {
    acc[m.kind] =
      m.kind === 'prompt' ? 'workflow-native'
      : m.kind === 'remote' ? 'remote'
      : m.binary || m.kind
    return acc
  },
  {} as Record<AgentKind, string>,
)

const VISIBILITY_LABEL: Record<string, 'workspace' | 'public'> = {
  public: 'public',
  workspace: 'workspace',
  private: 'workspace',
}

const AVAIL_LABEL: Record<AgentAvailability, string> = {
  online: '在线',
  unstable: '不稳定',
  offline: '离线',
}

/** Derive the detail-level availability from the daemon heartbeat state.
 *  `online` → online; `draining` → unstable; anything else (incl. null for
 *  prompt agents with no daemon) → offline. Mirrors the design's
 *  online/unstable/offline pill (`agent-detail.html:163-164`). */
export function deriveAvailability(daemonStatus: string | null): AgentAvailability {
  if (daemonStatus === 'online') return 'online'
  if (daemonStatus === 'draining') return 'unstable'
  return 'offline'
}

/** Availability → `.status` modifier class for the presence pill (design's
 *  `avClass`: online→running, unstable→queued, else idle). */
export function availabilityClass(av: AgentAvailability): string {
  if (av === 'online') return 'running'
  if (av === 'unstable') return 'queued'
  return 'idle'
}

/** Availability → Chinese label (design's `AVAIL_CN`). */
export function availabilityLabel(av: AgentAvailability): string {
  return AVAIL_LABEL[av]
}

/** Inverse of {@link deriveAvailability}: map a presence value back to the
 *  `daemon_status` string `deriveAvailability` reads, so a WS `agent-updated`
 *  delta (which carries presence, not raw daemon status) can be merged into a
 *  `CatalogAgent.daemonStatus` and re-derived consistently by
 *  `derivePageModel`. `online`→`online`, `unstable`→`draining`,
 *  `offline`→`offline`. */
export function availabilityToDaemonStatus(av: AgentAvailability): string {
  if (av === 'online') return 'online'
  if (av === 'unstable') return 'draining'
  return 'offline'
}

/**
 * Derive 30 daily activity buckets from the task history, oldest→newest
 * (bucket 0 = 29 days ago, bucket 29 = today). Each task is dropped into the
 * bucket for its `createdAt` day-offset; `total` counts tasks that day, `fail`
 * counts tasks whose status is `failed`, `ok = total - fail`. Tasks older than
 * 30 days (or in the future) are dropped — the sparkline is a 30-day window.
 * Pads to 30 with zero-buckets so the sparkline aligns across agents (design's
 * `buckets()` helper did the same with leading zeros).
 *
 * `nowMs` is threaded in (not read from `Date.now()`) so the derivation is
 * deterministic under test. Always returns exactly `ACTIVITY_BUCKET_COUNT`
 * buckets — the sparkline renders one bar per bucket regardless of history.
 */
export function deriveActivityBuckets(
  tasks: ReadonlyArray<{ status: string; createdAt: string }>,
  nowMs: number,
): AgentActivityBucket[] {
  const buckets: AgentActivityBucket[] = Array.from({ length: ACTIVITY_BUCKET_COUNT }, () => ({
    total: 0,
    ok: 0,
    fail: 0,
  }))
  for (const t of tasks) {
    const createdMs = parseMs(t.createdAt)
    if (!Number.isFinite(createdMs)) continue
    const deltaDays = Math.floor((nowMs - createdMs) / MS_PER_DAY)
    if (deltaDays < 0 || deltaDays >= ACTIVITY_BUCKET_COUNT) continue
    const idx = ACTIVITY_BUCKET_COUNT - 1 - deltaDays
    const b = buckets[idx]!
    b.total += 1
    if (t.status === 'failed') b.fail += 1
    else b.ok += 1
  }
  return buckets
}

function parseMs(iso: string): number {
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : NaN
}

/** Sum totals across the 30 buckets (design's 3-up KPI rollup:
 *  30 天总运行 / 成功率 / 失败次数). `successRate` is `'—'` when empty. */
export function sumBuckets(buckets: ReadonlyArray<AgentActivityBucket>): {
  total: number
  ok: number
  fail: number
  successRate: string
} {
  let total = 0
  let fail = 0
  for (const b of buckets) {
    total += b.total
    fail += b.fail
  }
  const ok = total - fail
  const successRate = total > 0 ? ((ok / total) * 100).toFixed(1) : '—'
  return { total, ok, fail, successRate }
}

/** Derive a 0–100 progress proxy from the current task status + elapsed ms.
 *  Running ramps with elapsed (capped at 100), failed → 100, else 0. Mirrors
 *  the drawer's `DrawerBody` heuristic so the two surfaces agree. */
export function deriveProgressPct(status: AgentStatus, elapsedMs: number | null): number {
  if (status === 'failed') return 100
  if (status !== 'running') return 0
  if (elapsedMs == null) return 10
  const minutes = elapsedMs / MS_PER_MIN
  return Math.min(100, Math.round(10 + Math.min(minutes, 10) * 9))
}

/** Format an elapsed-ms duration as the design's elapsed strings
 *  (`4m12s` / `2m01s` / `1h05m` / `排队中` / `—`). Pure; `elapsedMs` is the
 *  signed duration (not a "now" diff) so no timestamp is needed. */
export function formatElapsedMs(elapsedMs: number | null, status: AgentStatus): string {
  if (elapsedMs == null || elapsedMs < 0) {
    return status === 'queued' ? '排队中' : '—'
  }
  const totalSec = Math.floor(elapsedMs / MS_PER_SEC)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h${String(m % 60).padStart(2, '0')}m`
  }
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** Map the live `AgentDetail` + logs to the page render model. `nowMs` is
 *  threaded in for deterministic activity-bucket derivation. */
export function derivePageModel(
  detail: AgentDetail,
  logs: AgentLogLine[],
  nowMs: number,
): AgentDetailPageModel {
  const { agent } = detail
  const availability = deriveAvailability(agent.daemonStatus)
  const visibility: 'workspace' | 'public' = agent.visibility
    ? (VISIBILITY_LABEL[agent.visibility] ?? 'workspace')
    : 'workspace'
  const runtime =
    agent.kind === 'prompt'
      ? KIND_RUNTIME_PREFIX.prompt
      : agent.daemon !== '—'
        ? `${KIND_RUNTIME_PREFIX[agent.kind]} · ${agent.daemon}`
        : KIND_RUNTIME_PREFIX[agent.kind]
  const activity = deriveActivityBuckets(detail.tasks, nowMs)
  const { total: runCount, fail: failCount } = sumBuckets(activity)
  const elapsedMs = agent.status === 'running' ? agent.elapsedMs : null
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    roles: agent.roles,
    // summary: gateway top-level design field, falling back to the capability
    // descriptor's summary for dispatch-shaped rows that lack it.
    summary: agent.summary ?? agent.capability.summary ?? '—',
    status: agent.status,
    availability,
    // camelCase design fields (gateway DTO top-level). Fall back to `—` /
    // `（未设置提示词）` for rows that lack them (dispatch-shaped test fixtures).
    model: agent.model || '—',
    owner: agent.owner || '—',
    concurrency: agent.concurrency != null ? String(agent.concurrency) : '—',
    runtime,
    visibility,
    createdAt: agent.createdAt,
    instructions: agent.instructions || '（未设置提示词）',
    inputSchema: agent.inputSchema ?? agent.capability.inputSchema ?? '—',
    outputSchema: agent.outputSchema ?? agent.capability.outputSchema ?? '—',
    // skills: gateway top-level design field, falling back to roles
    // (capability descriptor tags) for dispatch-shaped rows.
    skills: agent.skills && agent.skills.length > 0 ? agent.skills : agent.roles,
    currentRun: agent.run,
    progress: deriveProgressPct(agent.status, agent.elapsedMs),
    elapsed: formatElapsedMs(elapsedMs, agent.status),
    region: agent.region,
    daemon: agent.daemon,
    load: agent.load,
    cost: agent.cost,
    activity,
    runCount,
    failCount,
    logs,
  }
}
