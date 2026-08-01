import { Hono } from 'hono'
import { ok } from './index.js'
import {
  FLEET_WINDOW_HOURS,
  windowSince,
  daemonStatusDistribution,
  agentFleet,
  taskStatusDistribution,
  throughput,
  regionBreakdown,
  costRollup,
  allAgentDaemonCalls,
} from './fleet-stats.js'
import { aggregateUsage } from './runs-usage.js'

/**
 * Fleet resource-dashboard read route (plan M6.5 / P1.11.T6): the
 * "资源看板数据聚合" acceptance gate.
 *
 *   GET /fleet-stats → { windowHours, generatedAt, fleet, throughput, regions, cost, usage, sources }
 *
 * Aggregates the four facets the resource panel (M5b.3) renders — fleet status
 * distribution / 24h throughput / region / cost — plus a per-model token
 * rollup, in one response so the panel makes a single call. Every facet is
 * best-effort: an empty fleet returns zeroed counts (a valid payload, not an
 * error), matching how `runs-usage` treats a run with no calls.
 *
 * `windowHours` (query param, default {@link FLEET_WINDOW_HOURS}, clamped to
 * 1–168) sizes the throughput + cost windows. The `generatedAt` timestamp is
 * the snapshot instant the aggregates were computed against; the window start
 * is `generatedAt - windowHours`.
 *
 * Read-only: parameterised raw SQL via `runQuery`, standard `{ success, data }`
 * envelope. Mirrors `runs-usage.ts` (no auth, no writes, JSONB forwarded
 * verbatim).
 */
export const fleetStatsRoutes = new Hono()

/** Lower/upper clamp for the `windowHours` query param (hours). */
const MIN_WINDOW = 1
const MAX_WINDOW = 168

fleetStatsRoutes.get('/fleet-stats', async (c) => {
  // `generatedAt` is pinned once per request so every facet shares one snapshot
  // instant — without this, a slow request would let the throughput window
  // drift relative to the cost window. `Date` is fine here (route runtime, not
  // a workflow script).
  const generatedAt = new Date()
  const raw = Number(c.req.query('windowHours') ?? FLEET_WINDOW_HOURS)
  const windowHours =
    Number.isFinite(raw) && raw >= MIN_WINDOW && raw <= MAX_WINDOW
      ? Math.floor(raw)
      : FLEET_WINDOW_HOURS
  const sinceIso = windowSince(generatedAt, windowHours)

  const [daemons, agents, tasks, tp, regions, cost, callSet] = await Promise.all([
    daemonStatusDistribution(),
    agentFleet(),
    taskStatusDistribution(),
    throughput(sinceIso),
    regionBreakdown(),
    costRollup(sinceIso),
    allAgentDaemonCalls(),
  ])
  const { calls, truncated } = callSet
  const { byModel, totalCalls } = aggregateUsage(calls)

  return ok(c, {
    windowHours,
    windowSince: sinceIso,
    generatedAt: generatedAt.toISOString(),
    fleet: {
      daemons: { byStatus: daemons.byStatus, total: daemons.total },
      agents: { total: agents.total, byKind: agents.byKind },
      tasks: { byStatus: tasks.byStatus, total: tasks.total },
    },
    throughput: {
      since: sinceIso,
      tasks: tp.tasks,
      runs: tp.runs,
    },
    regions,
    cost: {
      totalCost: cost.totalCost,
      last24hCost: cost.last24hCost,
      runsCounted: cost.runsCounted,
    },
    usage: {
      byModel,
      totalCalls,
      /**
       * Whether the per-model rollup hit the `CALL_ROLLUP_LIMIT` cap. `true`
       * means `totalCalls`/`byModel` are computed over a truncated sample of
       * the most recent calls, not the whole fleet — surfaced so the panel
       * shows a "partial data" badge instead of mistaking a capped count for
       * the true total. `cost.runsCounted` (SQL `COUNT(*)`) stays accurate
       * regardless.
       */
      truncated,
    },
    /**
     * Which sources contributed to this snapshot. `runs` (agent_daemon_calls)
     * is always present; `langfuse` + `new-api` are pending the OTel/clients
     * work (M6.1) so they read as `false` until wired — surfaced explicitly so
     * the panel can show "partial data" instead of mistaking absence for zero.
     */
    sources: {
      runs: true,
      langfuse: false,
      newApi: false,
    },
  })
})
