import { runQuery } from '@dagents/db'
import type { AgentDaemonCall } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { aggregateUsage, type ModelUsageTotals } from './runs-usage.js'

/**
 * Fleet resource-dashboard aggregation (plan M6.5 / P1.11.T6).
 *
 * The resource panel (M5b.3) renders four facets of the live fleet:
 *   - **status distribution** — daemons (online/offline/draining) + agents by
 *     kind + dispatch_tasks by lifecycle state;
 *   - **24h throughput** — tasks + runs reaching a terminal state in the last
 *     24h;
 *   - **region** — agents + run-cost grouped by `capability_descriptor->>'region'`
 *     (`'unknown'` when a daemon did not register one);
 *   - **cost** — fleet-wide `runs.cost` sum (total + last-24h) plus a per-model
 *     token rollup over every run's `agent_daemon_calls`.
 *
 * ## Data sources
 * The issue names `runs + Langfuse + new-api` as sources. In dispatch today
 * only `runs` (and the dispatch protocol tables) are owned: `runs.agent_daemon_calls`
 * already carries the per-model `usage` + optional `cost` that M6.2 lands, which
 * is the exact facet Langfuse would mirror — so the usage/cost rollup reads it
 * directly. There is no Langfuse client in this repo (M6.1 OTel work is still
 * in flight) and the new-api admin client lives in the gateway package, so
 * cross-service fetches are deferred: the response records which sources
 * contributed via `sources` and the panel can extend it when those clients land.
 *
 * ## Aggregation strategy
 * Counts / status / region / cost-sum are SQL-aggregated (one round-trip per
 * facet, no full-table haul). The per-model token rollup reuses the pure
 * `aggregateUsage` from `runs-usage.ts` over the flattened `agent_daemon_calls`
 * so a unit test can verify it without a database — same function already
 * backs the per-run usage route; fleet-wide is just a wider scope of the same
 * `AgentDaemonCall[]`. All access goes through `runQuery` parameterised raw
 * SQL, same decorator-free-reads rationale as the rest of dispatch.
 */

const log = createLogger({ svc: 'dispatch:fleet-stats' })

/** The throughput / cost window (hours). Matches the plan's "24h 吞吐" facet. */
export const FLEET_WINDOW_HOURS = 24

/** Guard against an unbounded full-table scan if the fleet ever grows. */
const REGION_LIMIT = 100

/** Row shape for the daemon-status distribution count. */
interface DaemonStatusRow {
  status: string
  count: string
}

/** Row shape for the agent-by-kind count. */
interface AgentKindRow {
  kind: string
  count: string
}

/** Row shape for the dispatch-task status distribution count. */
interface TaskStatusRow {
  status: string
  count: string
}

/** Row shape for the 24h terminal-count rollup. */
interface ThroughputRow {
  completed: string
  failed: string
  total: string
}

/** Row shape for the region grouping. */
interface RegionRow {
  region: string | null
  agents: string
  runs: string
  cost: string | null
}

/** Row shape for the cost rollup. */
interface CostRow {
  total_cost: string | null
  last24h_cost: string | null
  runs_counted: string
}

/** Row shape for one flattened agent-daemon-call (for the token rollup). */
interface CallRow {
  call: AgentDaemonCall
}

/**
 * Token totals for one model, accumulated across the whole fleet. Alias of
 * {@link ModelUsageTotals} (runs-usage.ts) — the per-run and fleet-wide
 * rollups produce the same shape, just over different scopes of the same
 * `AgentDaemonCall[]`.
 */
export type ModelFleetTotals = ModelUsageTotals

/**
 * The ISO timestamp `hours` before `now` (RFC3339, UTC).
 */
export function windowSince(now: Date, hours: number = FLEET_WINDOW_HOURS): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString()
}

/** Coerce a pg `COUNT()`/`SUM()` string cell to a finite number (0 on null/NaN). */
function toCount(v: string | null | undefined): number {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Daemon status distribution: counts by `daemons.status` (online/offline/draining).
 * `status` is a CHECK-constrained TEXT, so the keys are the three known states;
 * an unexpected value (schema drift) lands under its own key verbatim.
 */
export async function daemonStatusDistribution(): Promise<{
  byStatus: Record<string, number>
  total: number
}> {
  const { records } = await runQuery<DaemonStatusRow>(
    `SELECT status, COUNT(*)::text AS count FROM daemons GROUP BY status`,
  )
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const r of records) {
    byStatus[r.status] = toCount(r.count)
    total += toCount(r.count)
  }
  return { byStatus, total }
}

/**
 * Agent fleet: total count + by-kind breakdown (`agent_daemons.kind`).
 */
export async function agentFleet(): Promise<{
  total: number
  byKind: Record<string, number>
}> {
  const { records } = await runQuery<AgentKindRow>(
    `SELECT kind, COUNT(*)::text AS count FROM agent_daemons GROUP BY kind`,
  )
  const byKind: Record<string, number> = {}
  let total = 0
  for (const r of records) {
    byKind[r.kind] = toCount(r.count)
    total += toCount(r.count)
  }
  return { total, byKind }
}

/**
 * Dispatch-task lifecycle distribution: counts by `dispatch_tasks.status`
 * (queued/claimed/running/completed/failed).
 */
export async function taskStatusDistribution(): Promise<{
  byStatus: Record<string, number>
  total: number
}> {
  const { records } = await runQuery<TaskStatusRow>(
    `SELECT status, COUNT(*)::text AS count FROM dispatch_tasks GROUP BY status`,
  )
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const r of records) {
    byStatus[r.status] = toCount(r.count)
    total += toCount(r.count)
  }
  return { byStatus, total }
}

/**
 * 24h throughput: terminal tasks + terminal runs in the last `hours`.
 *
 * `finished_at` is the terminal timestamp for both tables; a run/task that has
 * not finished (still queued/running) is excluded. `total` is
 * completed + failed — `cancelled` runs are excluded by the `status IN
 * ('completed','failed')` filter (their `finished_at` may or may not be set,
 * but status is the gate).
 */
export async function throughput(
  sinceIso: string,
): Promise<{ tasks: ThroughputAgg; runs: ThroughputAgg }> {
  const { records: taskRows } = await runQuery<ThroughputRow>(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
        COUNT(*) FILTER (WHERE status IN ('completed','failed'))::text AS total
       FROM dispatch_tasks
      WHERE finished_at IS NOT NULL AND finished_at >= $1`,
    [sinceIso],
  )
  const { records: runRows } = await runQuery<ThroughputRow>(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
        COUNT(*) FILTER (WHERE status IN ('completed','failed'))::text AS total
       FROM runs
      WHERE finished_at IS NOT NULL AND finished_at >= $1`,
    [sinceIso],
  )
  const norm = (r: ThroughputRow): ThroughputAgg => ({
    completed: toCount(r.completed),
    failed: toCount(r.failed),
    total: toCount(r.total),
  })
  return { tasks: norm(taskRows[0]), runs: norm(runRows[0]) }
}

/** Terminal-count rollup for one table over the window. */
export interface ThroughputAgg {
  completed: number
  failed: number
  total: number
}

/**
 * Region grouping: agents + run-cost rolled up by
 * `agent_daemons.capability_descriptor->>'region'` (`'unknown'` when absent).
 *
 * Region is a free-form descriptor field (the spec has no dedicated region
 * column), so a daemon that did not register one is bucketed as `'unknown'`
 * rather than dropped — the panel still owes the operator a row for those
 * agents. `cost` is `runs.cost` summed over the runs whose `agent_daemon_calls`
 * reference an agent in that region (a run calls agents of possibly several
 * regions; its cost is attributed to each region it touched, so regional cost
 * is an upper-bound attribution, not a partition). `cost` is NUMERIC(18,6);
 * pg returns it as a string to preserve precision, forwarded verbatim.
 *
 * The cost is deduped per `(run, region)` before summing: a run that fans out
 * to N agents in the *same* region must contribute its cost once, not N times
 * (the `runs` table is fan-out-shaped — `parent_run_id` + parallel children
 * calling several same-region agents — so without dedupe the same `runs.cost`
 * would be multiplied by the agent count). A FULL JOIN keeps agents whose
 * region was never called by any run (those rows get `runs=0 / cost='0.000000'`)
 * so the agent count is never lost. Cross-region upper-bound attribution is
 * preserved: a run touching two regions still counts toward each.
 */
export async function regionBreakdown(): Promise<
  Array<{ region: string; agents: number; runs: number; cost: string }>
> {
  const { records } = await runQuery<RegionRow>(
    `SELECT COALESCE(a.region, rr.region, 'unknown') AS region,
            COALESCE(a.agents, 0)::text AS agents,
            COALESCE(rr.runs, 0)::text AS runs,
            COALESCE(rr.cost, 0)::numeric(18,6)::text AS cost
       FROM (
         SELECT COALESCE(capability_descriptor->>'region', 'unknown') AS region,
                COUNT(*)::int AS agents
           FROM agent_daemons GROUP BY 1
       ) a
       FULL JOIN (
         SELECT region, COUNT(*)::int AS runs, SUM(cost)::numeric(18,6) AS cost
           FROM (
             SELECT DISTINCT r.id, r.cost,
                    COALESCE(ad.capability_descriptor->>'region', 'unknown') AS region
               FROM runs r
               JOIN agent_daemons ad
                 ON r.agent_daemon_calls @> jsonb_build_array(jsonb_build_object('agentDaemonId', ad.id))
           ) t GROUP BY 1
       ) rr USING (region)
      ORDER BY agents DESC NULLS LAST
      LIMIT $1`,
    [REGION_LIMIT],
  )
  return records.map((r) => ({
    region: r.region ?? 'unknown',
    agents: toCount(r.agents),
    runs: toCount(r.runs),
    cost: r.cost ?? '0.000000',
  }))
}

/**
 * Fleet cost rollup: total + last-24h `runs.cost` sum and the count of runs
 * that carry a non-zero cost.
 *
 * `cost` is NUMERIC(18,6); pg returns it as a string to preserve precision,
 * forwarded verbatim — callers that need a Number coerce explicitly. The
 * last-24h sum is over `runs.finished_at` (a run still running has no
 * settled cost).
 */
export async function costRollup(sinceIso: string): Promise<{
  totalCost: string
  last24hCost: string
  runsCounted: number
}> {
  const { records } = await runQuery<CostRow>(
    `SELECT
        COALESCE(SUM(cost), 0)::numeric(18,6)::text AS total_cost,
        COALESCE(SUM(cost) FILTER (WHERE finished_at IS NOT NULL AND finished_at >= $1), 0)::numeric(18,6)::text AS last24h_cost,
        COUNT(*) FILTER (WHERE cost > 0)::text AS runs_counted
       FROM runs`,
    [sinceIso],
  )
  const row = records[0]
  return {
    totalCost: row.total_cost ?? '0',
    last24hCost: row.last24h_cost ?? '0',
    runsCounted: toCount(row.runs_counted),
  }
}

/**
 * Flatten every run's `agent_daemon_calls` into one array for the in-process
 * per-model token rollup.
 *
 * `jsonb_array_elements` expands each run's calls into one row per call; the
 * JSONB object is already parsed to an {@link AgentDaemonCall} by the pg
 * driver. A run with an empty array yields zero rows. Capped at
 * {@link CALL_ROLLUP_LIMIT} calls so an unbounded fleet cannot OOM the
 * process — the cap is logged when hit so the operator knows the rollup is
 * truncated (and the caller surfaces `usage.truncated` in the response).
 */
const CALL_ROLLUP_LIMIT = 50_000
export async function allAgentDaemonCalls(): Promise<{
  calls: AgentDaemonCall[]
  truncated: boolean
}> {
  const { records } = await runQuery<CallRow>(
    `SELECT elem AS call
       FROM runs, jsonb_array_elements(agent_daemon_calls) AS elem
      ORDER BY finished_at DESC NULLS LAST
      LIMIT $1`,
    [CALL_ROLLUP_LIMIT],
  )
  const truncated = records.length >= CALL_ROLLUP_LIMIT
  if (truncated) {
    log.warn('agent_daemon_calls rollup truncated', { limit: CALL_ROLLUP_LIMIT })
  }
  return { calls: records.map((r) => r.call), truncated }
}
