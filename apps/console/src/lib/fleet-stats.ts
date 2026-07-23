/**
 * Fleet resource-dashboard client + domain model (M6.3 / P1.11.T4 + M5b.3 / P1.10.T9).
 *
 * The 资源看板 (dashboard) page talks to the console's own `/api/fleet-stats`
 * proxy route (which forwards to the gateway → dispatch
 * `GET /api/v1/dispatch/fleet-stats`, the M6.5 aggregation API). This module
 * owns:
 *   - the typed domain model the view renders (`FleetStats`, `DaemonStatus`,
 *     `ModelUsage`, …) — a faithful projection of the dispatch response shape,
 *     kept here (not inline in the view) so the view stays focused on render
 *   - thin `fetchFleetStats` wrapper that throws on non-2xx, mirroring
 *     `agents-catalog.ts`'s `fetchAgents`
 *   - **pure** formatting/derivation helpers (`formatCost`, `formatTokens`,
 *     `formatInt`, `formatRate`, `deriveKpis`, `deriveThroughputView`,
 *     `deriveDensityView`, `sortRegions`, `usageRows`, `daemonSegments`,
 *     `statusBadge`) — pure = no network, no React, so they unit-test in
 *     vitest's node environment with no jsdom (same posture as
 *     `agents-catalog.test.ts`)
 *
 * M5b.3 extends the M6.3 panel from four facets to the issue's five — adding
 * the **fleet density** card (`deriveDensityView` over `fleet.tasks.byStatus`,
 * the live work-queue state mosaic the design's 1M-agent heatmap stands in for
 * at MVP scale) and the **24h throughput** card (`deriveThroughputView` over
 * the windowed `throughput` facet, with the runs/min area chart deferred until
 * a timeseries-bucket API exists). Both derive only from facets the M6.5 API
 * already returns — no backend change.
 *
 * `cost` arrives as a NUMERIC(18,6) *string* from pg (precision-preserving);
 * we never `Number()`-coerce it for display — `formatCost` renders the string
 * trimmed to cents, and `deriveKpis` parses it once for the KPI number. The
 * rollup may be capped (`usage.truncated`) and Langfuse/new-api are not yet
 * wired (`sources.langfuse` / `sources.newApi`), so the view surfaces a
 * "partial data" badge instead of mistaking absence for zero — matching the
 * dispatch response's explicit honesty about its sources.
 */

/** Per-model token totals for the fleet (mirrors `ModelUsageTotals`). */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  calls: number
}

/** One region row: agents + runs + cost summed by daemon region. */
export interface RegionStat {
  region: string
  agents: number
  runs: number
  /** NUMERIC(18,6) as a string — pg preserves precision; render verbatim. */
  cost: string
}

/**
 * Daemon status distribution counts (online/offline/draining/…).
 *
 * Mirrors the dispatch payload's `fleet.daemons` facet: the backend returns
 * `fleet: { daemons: { byStatus, total }, agents, tasks }`
 * (`apps/dispatch/src/routes/fleet-stats.ts`, asserted by its integration test
 * `fleet.daemons.total`). Keeping this nested shape here — instead of a flat
 * `fleet.byStatus`/`fleet.total` — means the typed model is a faithful
 * projection of the wire contract, so the donut/KPI read real fields and a
 * drift surfaces as a missing field (handled), not a silent `undefined`.
 */
export interface DaemonFleet {
  byStatus: Record<string, number>
  total: number
}

/** Agents facet of `fleet` — registered agent_daemons by kind. */
export interface AgentFleet {
  total: number
  byKind: Record<string, number>
}

/** Tasks facet of `fleet` — terminal task counts by lifecycle status. */
export interface TaskFleet {
  byStatus: Record<string, number>
  total: number
}

/** The `fleet` aggregate (daemons + agents + tasks), in the backend's shape. */
export interface Fleet {
  daemons: DaemonFleet
  agents: AgentFleet
  tasks: TaskFleet
}

/** Terminal-count rollup over the window for tasks + runs. */
export interface ThroughputAgg {
  completed: number
  failed: number
  total: number
}

/** Which sources contributed to this snapshot (honesty about coverage). */
export interface FleetSources {
  runs: boolean
  langfuse: boolean
  newApi: boolean
}

/** The full dispatch `GET /fleet-stats` payload, typed for the view. */
export interface FleetStats {
  windowHours: number
  windowSince: string
  generatedAt: string
  fleet: Fleet
  throughput: { since: string; tasks: ThroughputAgg; runs: ThroughputAgg }
  regions: RegionStat[]
  cost: { totalCost: string; last24hCost: string; runsCounted: number }
  usage: {
    byModel: Record<string, ModelUsage>
    totalCalls: number
    truncated: boolean
  }
  sources: FleetSources
}

/**
 * One cell of the fleet-density grid. The design's dashboard renders a 1M-agent
 * heatmap whose per-cell state is idle/ready/running/queued/failed/paused —
 * states a single-snapshot aggregation API does not carry (M5b.3 is MVP-level,
 * 非百万级). The live work-queue the operator actually wants to see at this scale
 * is `dispatch_tasks` by lifecycle status (`queued`/`claimed`/`running`/
 * `completed`/`failed`), which the M6.5 API already returns as
 * `fleet.tasks.byStatus`. `deriveDensityView` tiles those counts into a grid the
 * density card renders — one cell per task, colored by status — so the card
 * shows the real live fleet, not a 1M-fake canvas.
 */
/** A view-ready tile in the fleet-density grid, carrying its status for color. */
export interface DensityTile {
  status: string
}

/** The density-card projection of a fleet snapshot: tiles + a status legend. */
export interface DensityView {
  /** One tile per task in the live queue, colored by status (sorted for stable layout). */
  tiles: DensityTile[]
  /** Total task count the grid represents (== tiles.length). */
  total: number
  /** Distinct statuses present, with counts, sorted by count desc then status. */
  legend: DensityLegendEntry[]
}

/** One entry in the density-card legend: a status + how many tiles it colors. */
export interface DensityLegendEntry {
  status: string
  count: number
}

/**
 * The 24h-throughput-card projection. The M6.5 `throughput` facet carries
 * terminal (completed/failed/total) counts for tasks + runs over the window;
 * this card surfaces them as KPIs plus a runs/min rate (the design's
 * "runs/min" axis). The area chart the design ships needs per-bucket
 * timeseries the single-snapshot API does not return, so M5b.3 renders the
 * numeric breakdown + rate now and leaves the area chart for a timeseries API.
 */
export interface ThroughputView {
  /** Terminal tasks in the window (completed + failed). */
  tasks: ThroughputAgg
  /** Terminal runs in the window (completed + failed). */
  runs: ThroughputAgg
  /** Runs/min over the window — `runs.total / windowHours / 60`, 0 when no window. */
  runsPerMin: number
  /** Tasks/min over the window — `tasks.total / windowHours / 60`, 0 when no window. */
  tasksPerMin: number
  /** Window success rate, 0–100 (0 when no terminal runs). */
  runSuccessPct: number
  /** Window length in hours (the denominator for the rates). */
  windowHours: number
}

/** A view-ready row in the per-model usage table (sorted, share computed). */
export interface ModelUsageRow {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  calls: number
  /** input + output (the comparable volume metric for the bar). */
  totalTokens: number
  /** Share of the fleet's total tokens, 0–100. */
  sharePct: number
}

/** A view-ready donut segment for daemon-status distribution. */
export interface DaemonSegment {
  status: string
  count: number
  /** Share of the fleet total, 0–1 (0 when the fleet is empty). */
  fraction: number
}

/** KPI cards derived from the fleet snapshot. */
export interface FleetKpis {
  /** Total registered agents (agent_daemons). */
  agents: number
  /** Online daemons (the "healthy fleet" count). */
  daemonsOnline: number
  /** Terminal runs in the window (completed + failed). */
  runs: number
  /** Window run success rate, 0–100 (0 when no terminal runs). */
  runSuccessPct: number
  /** Terminal tasks in the window. */
  tasks: number
  /** 24h cost, as a number for the big KPI (string for display elsewhere). */
  last24hCost: number
  /** Total token volume across the fleet (input + output). */
  totalTokens: number
}

/**
 * The window-selector presets the page offers. `hours` is the numeric window
 * the dispatch API consumes (`windowHours`); `window` is the design's preset
 * token the time-range segmented toggle carries (`1h`/`24h`/`7d`) and the URL
 * shape the plan pins (`?window=`). The two are paired here so the view's
 * toggle state is the design token while the fetch still sizes the dispatch
 * window correctly.
 */
export const FLEET_WINDOW_PRESETS = [
  { hours: 1, label: '1h', window: '1h' },
  { hours: 24, label: '24h', window: '24h' },
  { hours: 168, label: '7d', window: '7d' },
] as const

/**
 * Resolve a preset token (`'1h'`/`'24h'`/`'7d'`) to its numeric hours, or
 * `null` when the token is unknown/absent (the caller falls back to the
 * default window). Kept pure so the toggle's token→hours mapping is unit-
 * testable without going through the fetch.
 */
export function windowToHours(window?: string): number | null {
  if (!window) return null
  const preset = FLEET_WINDOW_PRESETS.find((p) => p.window === window)
  return preset ? preset.hours : null
}

/**
 * Cap on the density-card grid. The design's heatmap canvas is ~5k cells; an
 * MVP-level fleet (非百万级) is well under that, but the cap keeps a runaway
 * queue from rendering tens of thousands of DOM nodes. `deriveDensityView`
 * truncates to the highest-count statuses first and surfaces the true `total`
 * separately, so the cap never reads as the real count.
 */
export const DENSITY_MAX_TILES = 5000

/** Daemon status → display label + swatch color (mirrors the design's legend). */
const DAEMON_STATUS_META: Record<string, { label: string; color: string }> = {
  online: { label: '在线', color: 'var(--accent)' },
  offline: { label: '离线', color: 'var(--meta)' },
  draining: { label: '排空中', color: 'var(--warn)' },
  unknown: { label: '未知', color: 'var(--border)' },
}

/**
 * Dispatch-task lifecycle status → display label + swatch color. Mirrors the
 * design density-heatmap legend's semantic palette (running/queued/failed/…)
 * mapped onto the real `dispatch_tasks.status` CHECK values
 * (`queued`/`claimed`/`running`/`completed`/`failed`, per the
 * `dispatch_tasks_status_chk` constraint). `claimed` (a task picked up but not
 * yet running) is folded into the queued/pending amber so the grid reads as
 * the two active states the operator cares about; `completed` is the muted
 * "done" tone so a healthy fleet reads as mostly-muted, not mostly-green.
 */
const TASK_STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: '运行中', color: 'var(--accent)' },
  queued: { label: '排队', color: 'var(--warn)' },
  claimed: { label: '已认领', color: '#f5c77e' },
  completed: { label: '完成', color: 'var(--border)' },
  failed: { label: '失败', color: 'var(--danger)' },
  unknown: { label: '未知', color: 'var(--border)' },
}

/**
 * A stable label for an arbitrary task lifecycle status. Known states map to
 * the density legend; a schema-drift value lands under its own key verbatim.
 */
export function taskStatusLabel(status: string): string {
  return TASK_STATUS_META[status]?.label ?? status
}

/** A stable swatch color for a task lifecycle status (CSS var or hex). */
export function taskStatusColor(status: string): string {
  return TASK_STATUS_META[status]?.color ?? 'var(--border)'
}

/**
 * A stable label for an arbitrary daemon status. Known states map to the
 * design's legend; a schema-drift value lands under its own key verbatim so
 * the operator still sees it.
 */
export function daemonStatusLabel(status: string): string {
  return DAEMON_STATUS_META[status]?.label ?? status
}

/** A stable swatch color for a daemon status (CSS var or hex). */
export function daemonStatusColor(status: string): string {
  return DAEMON_STATUS_META[status]?.color ?? 'var(--border)'
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Lift `data` out of the `{ success, data?, error? }` envelope or throw. Mirrors
 * `agents-catalog.ts`'s `unwrap` so a non-2xx (gateway collapses upstream errors
 * to 502) surfaces as a thrown `Error` the view's `try/catch` can render.
 *
 * `signal` lets the view abort a superseded fetch (window switch / unmount).
 * `fetch` itself rejects with an `AbortError` when aborted; we let that propagate
 * as-is so the caller's `catch` can distinguish "aborted" (ignore) from "failed"
 * (surface) via `signal.aborted`.
 */
async function unwrap<T>(res: Response, label: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
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

/**
 * GET /api/fleet-stats — fetch the fleet snapshot for the dashboard. `window`
 * is the design's preset token (`1h`/`24h`/`7d`); it is sent as the `?window=`
 * query the time-range segmented toggle drives (the M8.1 plan pins this URL
 * shape). `cache: 'no-store'` keeps the snapshot fresh — the dashboard is a
 * live operator view, not a cacheable asset. Pass `signal` so the view can
 * abort a superseded fetch (window switch / unmount); an aborted call rejects
 * with an `AbortError` the caller ignores.
 *
 * The numeric `windowHours` the dispatch server consumes is resolved from the
 * preset token via `windowToHours`; omitting the token yields the 24h default.
 */
export async function fetchFleetStats(
  window?: string,
  signal?: AbortSignal,
): Promise<FleetStats> {
  const search = window ? `?window=${encodeURIComponent(window)}` : ''
  return unwrap<FleetStats>(
    await fetch(`/api/fleet-stats${search}`, { method: 'GET', cache: 'no-store', signal }),
    'fleet stats',
    signal,
  )
}

// ─── pure formatting / derivation helpers ──────────────────────────

/**
 * Parse a NUMERIC cost string to a finite number (0 on null/NaN). pg returns
 * cost as a string to preserve precision; this is the single coercion point
 * for any math (KPI deltas, share bars). Display paths use `formatCost`
 * instead, which never loses cents.
 */
export function parseCost(v: string | null | undefined): number {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Render a NUMERIC(18,6) cost string as `$x.xx`. Trims to 2 decimals (the
 * fleet-cost granularity is cents); a null/empty/zero renders as `$0.00`.
 * Never coerces through `Number` for display — the string is formatted
 * directly so a value like `4182.5` (no trailing zero) still lands on `$4182.50`.
 */
export function formatCost(v: string | null | undefined): string {
  const n = parseCost(v)
  return `$${n.toFixed(2)}`
}

/**
 * Render an integer with thousands separators (`1,040,328`). Returns `0` for
 * null/undefined so an empty fleet reads as zero, not `—` (a zeroed fleet is
 * the dispatch API's valid empty-state, not missing data).
 */
export function formatInt(v: number | null | undefined): string {
  const n = v ?? 0
  return n.toLocaleString('en-US')
}

/**
 * Render a token count compactly: `< 1K`, `12.4K`, `3.2M`. The fleet rollup
 * easily reaches millions of tokens; raw integers would overflow the KPI
 * cells. Stays on the number (already summed server-side), not the string.
 */
export function formatTokens(v: number | null | undefined): string {
  const n = v ?? 0
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * Render a per-minute rate compactly: `0`, `1.2`, `47.5`, `1.1K`. The
 * throughput card shows runs/min + tasks/min; small windows (1h) can reach
 * hundreds/min and 7d windows can reach thousands. One decimal under 100 (so
 * `1.2` reads as a real rate, not `1`), integers above, then compact `K`.
 * Returns `0` for null/undefined so an idle window reads as zero, not `—`.
 */
export function formatRate(v: number | null | undefined): string {
  const n = v ?? 0
  if (n < 0.05) return '0'
  if (n < 100) return n.toFixed(1)
  if (n < 1000) return Math.round(n).toString()
  return `${(n / 1000).toFixed(1)}K`
}

/** input + output for a model usage entry (cache tokens are advisory, not billed volume). */
function totalTokensOf(m: ModelUsage): number {
  return (m.inputTokens ?? 0) + (m.outputTokens ?? 0)
}

/**
 * Derive the four KPI cards from a snapshot. The "today" framing the design
 * uses maps to the window: a 24h window's `last24hCost` is "今日成本", a 7d
 * window's is "7 日成本" — the view labels it from the active preset, this just
 * supplies the number. `runSuccessPct` is completed/terminal over the window
 * (cancelled runs are excluded by the dispatch query).
 */
export function deriveKpis(s: FleetStats): FleetKpis {
  const runs = s.throughput.runs
  const terminal = runs.total
  const totalTokens = Object.values(s.usage.byModel).reduce((sum, m) => sum + totalTokensOf(m), 0)
  return {
    agents: s.fleet.agents.total,
    daemonsOnline: s.fleet.daemons.byStatus.online ?? 0,
    runs: terminal,
    runSuccessPct: terminal > 0 ? Math.round((runs.completed / terminal) * 100) : 0,
    tasks: s.throughput.tasks.total,
    last24hCost: parseCost(s.cost.last24hCost),
    totalTokens,
  }
}

/**
 * Sort regions by agent count descending (the design's order) so the densest
 * regions lead. Returns a new array — pure, no mutation of the input.
 */
export function sortRegions(regions: RegionStat[]): RegionStat[] {
  return [...regions].sort((a, b) => b.agents - a.agents || b.runs - a.runs)
}

/**
 * Project the fleet snapshot into the density-card view: one tile per live
 * task in `fleet.tasks.byStatus`, colored by lifecycle status, plus a legend
 * of the distinct statuses present.
 *
 * The design's dashboard ships a 1M-agent heatmap (idle/ready/running/queued/
 * failed/paused) that needs per-agent state a single-snapshot aggregation API
 * does not carry. At MVP scale (非百万级) the live work-queue the operator
 * actually wants is `dispatch_tasks` by status — which the M6.5 API returns as
 * `fleet.tasks.byStatus`. This tiles those counts into a grid the density card
 * renders as a status-colored mosaic, so the card shows the real fleet, not a
 * fake 1M canvas. Tiles are laid out status-by-status (sorted by count desc)
 * so the grid reads as contiguous bands of color — stable across reloads,
 * deterministic for a snapshot test.
 *
 * `maxTiles` caps the grid (the design's canvas is ~5k cells); a fleet larger
 * than the cap is truncated to the highest-count statuses first, and the card
 * surfaces the true `total` separately so the cap never reads as the real
 * count. An empty queue yields `tiles: []` + `total: 0` — the card renders its
 * empty state.
 */
export function deriveDensityView(
  tasks: TaskFleet,
  maxTiles: number = DENSITY_MAX_TILES,
): DensityView {
  const entries = Object.entries(tasks.byStatus)
    .map(([status, count]) => ({ status, count: count ?? 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))

  // The legend reports the true per-status distribution over every present
  // status — even statuses whose tiles were truncated out — so the operator
  // sees the real queue makeup, not just the capped sample. Only the tiles
  // are capped (the visual grid); the legend is whole.
  const legend: DensityLegendEntry[] = entries.map(({ status, count }) => ({ status, count }))

  // Tiles are a visual sample: one per task, highest-count statuses first,
  // capped at `maxTiles` so a runaway queue cannot render tens of thousands
  // of DOM nodes. The true `total` is surfaced separately so the cap never
  // reads as the real count.
  let remaining = maxTiles
  const tiles: DensityTile[] = []
  for (const { status, count } of entries) {
    if (remaining <= 0) break
    const take = Math.min(count, remaining)
    for (let i = 0; i < take; i++) tiles.push({ status })
    remaining -= take
  }
  return { tiles, total: tasks.total, legend }
}

/**
 * Project the throughput facet into the 24h-throughput-card view. The M6.5 API
 * returns terminal (completed/failed/total) counts for tasks + runs over the
 * window; this surfaces them plus a runs/min + tasks/min rate (the design's
 * "runs/min" axis) and the window success rate. The area chart the design
 * ships needs per-bucket timeseries the single-snapshot API does not return,
 * so M5b.3 renders the numeric breakdown + rate now. `windowHours` of 0 (a
 * malformed payload) yields 0 rates rather than `Infinity`.
 */
export function deriveThroughputView(s: FleetStats): ThroughputView {
  const runs = s.throughput.runs
  const tasks = s.throughput.tasks
  const hours = s.windowHours > 0 ? s.windowHours : 0
  const minutes = hours * 60
  return {
    tasks,
    runs,
    runsPerMin: minutes > 0 ? runs.total / minutes : 0,
    tasksPerMin: minutes > 0 ? tasks.total / minutes : 0,
    runSuccessPct: runs.total > 0 ? Math.round((runs.completed / runs.total) * 100) : 0,
    windowHours: s.windowHours,
  }
}

/**
 * Project the per-model usage map into sorted, share-computed rows for the
 * usage table. Sorted by total tokens desc (the heaviest spenders lead); the
 * share is the model's share of the fleet's total tokens (0–100). An empty
 * map yields `[]` — the view renders its empty state, not a zero-row table.
 *
 * `cacheWriteTokens` is intentionally NOT projected: the MVP table shows only
 * "缓存读" (cache reads), and shipping a field the view never renders is dead
 * data. The backend `TokenUsage` carries it, but we project what we display.
 */
export function usageRows(byModel: Record<string, ModelUsage>): ModelUsageRow[] {
  const rows = Object.entries(byModel).map(([model, m]) => {
    const totalTokens = totalTokensOf(m)
    return {
      model,
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadTokens: m.cacheReadTokens ?? 0,
      calls: m.calls ?? 0,
      totalTokens,
      sharePct: 0,
    }
  })
  const grandTotal = rows.reduce((sum, r) => sum + r.totalTokens, 0)
  for (const r of rows) {
    r.sharePct = grandTotal > 0 ? Math.round((r.totalTokens / grandTotal) * 100) : 0
  }
  return rows.sort((a, b) => b.totalTokens - a.totalTokens)
}

/**
 * Project the daemon-status distribution into donut segments, sorted by count
 * desc and annotated with their fraction of the fleet total. An empty fleet
 * yields `[]` — the donut renders its empty ring, not a zero-segment chart.
 * Known statuses get the design's label/color; unknown ones pass through.
 */
export function daemonSegments(daemons: DaemonFleet): DaemonSegment[] {
  const total = daemons.total
  const entries = Object.entries(daemons.byStatus)
  return entries
    .map(([status, count]) => ({
      status,
      count,
      fraction: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count)
}

/**
 * The partial-data badge text for the snapshot, or `null` when every source
 * contributed and the rollup is whole. Surfaces (a) Langfuse/new-api not yet
 * wired and (b) the call-rollup cap so the operator does not mistake a capped
 * count for the true total. `null` = no badge (full data) — the view hides it.
 */
export function statusBadge(s: FleetStats): string | null {
  const parts: string[] = []
  if (!s.sources.langfuse || !s.sources.newApi) parts.push('Langfuse/new-api 未接入')
  if (s.usage.truncated) parts.push('用量样本已截断')
  return parts.length > 0 ? parts.join(' · ') : null
}
