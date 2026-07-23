/**
 * Agents catalogue client + domain mapping (M5a.2 / P1.10.T4).
 *
 * The Agents 管理页 talks to the console's own `/api/agents/*` proxy routes
 * (which forward to the gateway → dispatch `GET /agents[/:id[/logs]]`). This
 * module owns:
 *   - the typed domain model the view renders (`CatalogAgent`, `AgentDetail`,
 *     `AgentLogLine`)
 *   - thin `fetch` wrappers (`fetchAgents` / `fetchAgentDetail` /
 *     `fetchAgentLogs`) that throw on non-2xx, mirroring chat-client.ts
 *   - **pure** mappers that turn the raw dispatch rows into the domain model
 *     (`mapRowToCatalogAgent`, `deriveStatus`, `deriveLoad`, `deriveCost`,
 *     `deriveKpis`, `filterAgents`, `eventToLogLine`). Pure = no network, no
 *     React — so they are unit-testable in vitest's node environment with no
 *     jsdom, matching sse.test.ts.
 *
 * `agent_daemons.kind` is free TEXT. The design's 4 kinds (prompt / claude /
 * codex / remote) are the catalogue's filter set; an unknown kind maps to
 * `remote` so the fleet still renders. `region` is best-effort: there is no
 * region column, so it is derived from a daemon-capability `region`/`tags`
 * hint if present, else `—`.
 */

/** The design's 4 agent kinds (agents.html filter chips). */
export type AgentKind = 'prompt' | 'claude' | 'codex' | 'remote'

/** Lifecycle status surfaced in the list/kanban. `paused` has no dispatch
 *  source today (no pause state in `dispatch_tasks`); it is kept in the union
 *  so the kanban's 5th column + the design's status labels map 1:1. */
export type AgentStatus = 'running' | 'queued' | 'idle' | 'failed' | 'paused' | 'done'

/** One row in the agents list. */
export interface CatalogAgent {
  id: string
  name: string
  kind: AgentKind
  /** Role tags from the capability descriptor (`tags`) — reader/coding/verify/… */
  roles: string[]
  status: AgentStatus
  /** Daemon label hosting this agent (`daemons.label`), or `—` for prompt agents. */
  daemon: string
  /** Best-effort region from daemon capabilities, else `—`. */
  region: string
  /** Current run id (latest task's `run_id`), or `null` when idle. */
  run: string | null
  /** Derived load 0–100 (running tasks push it up; idle → 0). */
  load: number
  /** Today's cost for this agent, formatted `$x.xx`, or `—`. */
  cost: string
  /** Latest task id, if any (drives the drawer's "current task"). */
  latestTaskId: string | null
  latestTaskStatus: string | null
  /** ms elapsed on the current task, or null. */
  elapsedMs: number | null
  /** capability descriptor (name/summary/inputSchema/outputSchema/tags). */
  capability: CapabilityDescriptor
  createdAt: string
  /** Raw daemon state — `online`/`offline`/`draining` (or null for prompt
   *  agents). The agent-detail page's live-presence indicator (design's
   *  availability pill) derives from this; the catalogue list ignores it. */
  daemonStatus: string | null
  /** `workspace` or `public` (agent_daemons.visibility); null when unset.
   *  Surfaced for the detail inspector's 可见性 row (dropped by the M5a.2
   *  mapper; restored here so the detail page reads real data). */
  visibility: string | null
}

/** Capability descriptor shape (agent_daemons.capability_descriptor JSONB). */
export interface CapabilityDescriptor {
  name?: string
  summary?: string
  inputSchema?: string
  outputSchema?: string
  tags?: string[]
}

/** A recent task in the detail history (sparkline + cost rollup). */
export interface AgentTaskHistory {
  id: string
  runId: string
  status: string
  usage: unknown
  durationMs: number | null
  createdAt: string
  finishedAt: string | null
}

/** Full detail payload for the drawer. */
export interface AgentDetail {
  agent: CatalogAgent
  tasks: AgentTaskHistory[]
  runs: { id: string; identifier: string; status: string; cost: string }[]
}

/** One log line in the drawer's `.log` stream. */
export interface AgentLogLine {
  ts: string
  level: 'info' | 'ok' | 'warn' | 'err'
  msg: string
}

/** Filter model — single-select-within-group, matching agents.html chips. */
export interface AgentFilters {
  kind: AgentKind | null
  status: AgentStatus | null
  role: string | null
  /** Free-text over name / id / kind. */
  q: string
}

export const NO_FILTERS: AgentFilters = { kind: null, status: null, role: null, q: '' }

/** KPI row derived from the fetched list. */
export interface AgentKpis {
  total: number
  running: number
  avgLoad: number
  failedRate: number
}

/** The raw list-row shape from `GET /agents` (snake_case from pg). */
interface AgentListRow {
  id: string
  name: string
  kind: string
  capability_descriptor: unknown
  executable_path: string | null
  visibility: string | null
  created_at: Date | string
  daemon_label: string | null
  daemon_status: string | null
  last_heartbeat_at: Date | string | null
  daemon_capabilities: unknown
  task_id: string | null
  run_id: string | null
  task_status: string | null
  usage: unknown
  duration_ms: number | null
  task_created_at: Date | string | null
  finished_at: Date | string | null
}

interface AgentDetailRow {
  agent: AgentListRow
  tasks: {
    id: string
    run_id: string
    status: string
    usage: unknown
    duration_ms: number | null
    created_at: Date | string
    finished_at: Date | string | null
  }[]
  runs: { id: string; identifier: string; status: string; cost: string }[]
}

/** Known kinds from the design; anything else → `remote`. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(['prompt', 'claude', 'codex', 'remote'])

export function normalizeKind(kind: string): AgentKind {
  const k = kind.toLowerCase()
  if (KNOWN_KINDS.has(k)) return k as AgentKind
  return 'remote'
}

/** Parse a capability descriptor that may be a string or already an object. */
export function parseCapability(raw: unknown): CapabilityDescriptor {
  if (raw && typeof raw === 'object') return raw as CapabilityDescriptor
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as CapabilityDescriptor) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Extract a best-effort region from daemon capabilities tags. */
function deriveRegion(daemonCapabilities: unknown): string {
  if (!Array.isArray(daemonCapabilities)) return '—'
  for (const cap of daemonCapabilities) {
    if (!cap || typeof cap !== 'object') continue
    const tags = (cap as { tags?: unknown }).tags
    if (Array.isArray(tags)) {
      const region = tags.find(
        (t): t is string =>
          typeof t === 'string' &&
          /^(ap-|us-|eu-|sa-|me-|af-|cn-)/.test(t),
      )
      if (region) return region
    }
  }
  return '—'
}

/**
 * Derive an agent's display status from its latest task + daemon state.
 *
 * The dispatch task lifecycle is queued → claimed → running → completed/failed.
 * The catalogue collapses that to the design's 5 kanban columns:
 *   - latest task running    → `running`
 *   - latest task queued/claimed → `queued`
 *   - latest task failed     → `failed`
 *   - latest task completed + daemon online → `idle` (finished, awaiting work)
 *   - no task at all         → `idle`
 * `paused` is never derived (no pause state in dispatch) but stays in the union
 * for the design's status label map.
 */
export function deriveStatus(
  taskStatus: string | null,
  daemonStatus: string | null,
): AgentStatus {
  if (taskStatus === 'running') return 'running'
  if (taskStatus === 'queued' || taskStatus === 'claimed') return 'queued'
  if (taskStatus === 'failed') return 'failed'
  if (taskStatus === 'completed' || taskStatus === 'done') return 'idle'
  // No task (or terminal) — if the daemon is draining/offline, surface idle
  // (paused has no source). Idle is the honest "available" state.
  void daemonStatus
  return 'idle'
}

/**
 * Derive a 0–100 load proxy. With no CPU metric in the schema, load is a
 * coarse proxy from the current task: running → a band based on elapsed time
 * (longer-running tasks read as "busier"), capped at 99; queued → a small
 * pending value; everything else → 0. This keeps the load bar meaningful
 * without inventing a metric the DB doesn't track.
 */
export function deriveLoad(
  taskStatus: string | null,
  elapsedMs: number | null,
): number {
  if (taskStatus === 'running') {
    if (elapsedMs == null) return 50
    // Ramp from ~30% at 0s toward ~95% past 10min, bounded.
    const minutes = elapsedMs / 60_000
    return Math.min(99, Math.round(30 + Math.min(minutes, 10) * 6.5))
  }
  if (taskStatus === 'queued' || taskStatus === 'claimed') return 10
  return 0
}

/** ms elapsed on the current task, or null when not running. */
export function deriveElapsedMs(
  taskStatus: string | null,
  taskCreatedAt: Date | string | null,
  finishedAt: Date | string | null,
): number | null {
  if (taskStatus !== 'running') {
    // For a terminal task, elapsed = finished - created (the drawer shows how
    // long the last run took); for queued/idle there is no elapsed.
    if (finishedAt && taskCreatedAt && (taskStatus === 'completed' || taskStatus === 'failed')) {
      return toDateMs(finishedAt) - toDateMs(taskCreatedAt)
    }
    return null
  }
  if (!taskCreatedAt) return null
  return Date.now() - toDateMs(taskCreatedAt)
}

function toDateMs(d: Date | string): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime()
}

/** Token usage from a task's `usage` JSONB, summed across models. */
export function sumUsageTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0
  let total = 0
  for (const v of Object.values(usage as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      const u = v as { inputTokens?: unknown; outputTokens?: unknown }
      total += num(u.inputTokens) + num(u.outputTokens)
    }
  }
  return total
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Derive a cost string from the latest task's usage. There is no cost column
 * yet (runs.cost is empty today), so we proxy from token usage at a flat
 * $0.01 / 1k tokens — enough to populate the column with a real, sortable
 * number rather than a placeholder. `—` when there is no usage.
 */
export function deriveCost(usage: unknown): string {
  const tokens = sumUsageTokens(usage)
  if (tokens <= 0) return '—'
  const dollars = (tokens / 1000) * 0.01
  return `$${dollars.toFixed(2)}`
}

/** Map a raw dispatch list row to the catalogue domain model. */
export function mapRowToCatalogAgent(row: AgentListRow): CatalogAgent {
  const cap = parseCapability(row.capability_descriptor)
  const status = deriveStatus(row.task_status, row.daemon_status)
  const elapsedMs = deriveElapsedMs(row.task_status, row.task_created_at, row.finished_at)
  return {
    id: row.id,
    name: row.name,
    kind: normalizeKind(row.kind),
    roles: Array.isArray(cap.tags) ? cap.tags.filter((t): t is string => typeof t === 'string') : [],
    status,
    daemon: row.daemon_label ?? '—',
    region: deriveRegion(row.daemon_capabilities),
    run: row.run_id ?? null,
    load: deriveLoad(row.task_status, elapsedMs),
    cost: deriveCost(row.usage),
    latestTaskId: row.task_id,
    latestTaskStatus: row.task_status,
    elapsedMs,
    capability: cap,
    createdAt: toDateStr(row.created_at),
    daemonStatus: row.daemon_status,
    visibility: row.visibility,
  }
}

function toDateStr(d: Date | string): string {
  return (d instanceof Date ? d : new Date(d)).toISOString()
}

/** Apply the filter model to a fetched list (client-side, MVP-scale). */
export function filterAgents(agents: CatalogAgent[], filters: AgentFilters): CatalogAgent[] {
  const q = filters.q.trim().toLowerCase()
  return agents.filter((a) => {
    if (filters.kind && a.kind !== filters.kind) return false
    if (filters.status && a.status !== filters.status) return false
    if (filters.role && !a.roles.includes(filters.role)) return false
    if (q) {
      const hay = `${a.name} ${a.id} ${a.kind}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Derive the 4 KPI cards from the full fetched list. */
export function deriveKpis(agents: CatalogAgent[]): AgentKpis {
  const total = agents.length
  if (total === 0) return { total: 0, running: 0, avgLoad: 0, failedRate: 0 }
  const running = agents.filter((a) => a.status === 'running').length
  const failed = agents.filter((a) => a.status === 'failed').length
  const avgLoad = Math.round(agents.reduce((s, a) => s + a.load, 0) / total)
  const failedRate = Math.round((failed / total) * 1000) / 10
  return { total, running, avgLoad, failedRate }
}

/** Map a dispatch event payload to a drawer log line (mirrors dispatch route). */
export function eventToLogLine(
  payload: unknown,
  createdAt: Date | string,
): AgentLogLine {
  const p = (payload ?? {}) as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : ''
  const level: AgentLogLine['level'] =
    type === 'error' ? 'err'
    : type === 'status' ? 'ok'
    : type === 'log' ? 'info'
    : type === 'tool-use' ? 'info'
    : 'info'
  const msg =
    typeof p.content === 'string' ? p.content
    : typeof p.output === 'string' ? p.output
    : typeof p.status === 'string' ? p.status
    : type ? `[${type}]`
    : ''
  return {
    ts: createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString(),
    level,
    msg,
  }
}

// ─── fetch wrappers ──────────────────────────────────────────────────────

/** Envelope shared by all dispatch routes (`{ success, data }` / `{ success, error }`). */
interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

/** Fetch + map the agents list. Returns the domain agents (filters applied by caller). */
export async function fetchAgents(): Promise<{ agents: CatalogAgent[]; truncated: boolean }> {
  const data = await unwrap<{ agents: AgentListRow[]; truncated: boolean }>(
    await fetch('/api/agents', { cache: 'no-store' }),
    'agents list',
  )
  return { agents: data.agents.map(mapRowToCatalogAgent), truncated: data.truncated }
}

/** Fetch + map the full agent detail (latest row + recent task history + runs). */
export async function fetchAgentDetail(id: string): Promise<AgentDetail> {
  const data = await unwrap<AgentDetailRow>(
    await fetch(`/api/agents/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    'agent detail',
  )
  return {
    agent: mapRowToCatalogAgent(data.agent),
    tasks: data.tasks.map((t) => ({
      id: t.id,
      runId: t.run_id,
      status: t.status,
      usage: t.usage,
      durationMs: t.duration_ms,
      createdAt: toDateStr(t.created_at),
      finishedAt: t.finished_at ? toDateStr(t.finished_at) : null,
    })),
    runs: data.runs,
  }
}

/** Fetch the drawer log stream. */
export async function fetchAgentLogs(id: string): Promise<AgentLogLine[]> {
  const data = await unwrap<{ logs: { ts: string; level: string; msg: string }[] }>(
    await fetch(`/api/agents/${encodeURIComponent(id)}/logs`, { cache: 'no-store' }),
    'agent logs',
  )
  // Server already maps payload→{ts,level,msg}; coerce level into our union.
  return data.logs.map((l) => ({
    ts: l.ts,
    level: (['info', 'ok', 'warn', 'err'].includes(l.level) ? l.level : 'info') as AgentLogLine['level'],
    msg: l.msg,
  }))
}
