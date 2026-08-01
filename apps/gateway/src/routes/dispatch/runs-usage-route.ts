import { Hono } from 'hono'
import { runQuery } from '@dagents/db'
import { getRunUsage, aggregateUsage } from './runs-usage.js'
import { ok, fail } from './index.js'

/**
 * Run usage read route (plan M6.2 / P1.11.T3): the "usage 可查" acceptance gate.
 *
 *   GET /runs/:runId/usage → { run, calls, totals }
 *
 * Surfaces a run's `agent_daemon_calls` log plus a per-model token rollup —
 * the exact payload the resource panel (M6.3) and the Agents 管理页 drawer
 * (M5a.2) read to render per-run / per-agent spend. `agent_daemon_calls` is
 * populated by dispatch on each terminal task transition (see `runs-usage.ts`).
 *
 * `runId` is a UUID; we validate the shape (400) so a mistyped id is a clean
 * client error rather than a 404 that looks like "run exists but has no
 * usage". 404 when the run id matches no `runs` row. `agent_daemon_calls` and
 * `usage` are JSONB — the pg driver already parses them to objects, so they
 * are forwarded verbatim (never re-stringified, mirroring tasks.ts).
 *
 * `cost` is NUMERIC(18,6); pg returns it as a string to preserve precision, so
 * it is forwarded verbatim — callers that need a Number coerce explicitly.
 */
export const runsUsageRoutes = new Hono()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /runs/:runId/usage — a run's agent-daemon-call log + aggregated totals.
 *
 * Returns the run row (id, status, cost, duration, timestamps) alongside its
 * `calls` array and a per-model `totals` rollup (`aggregateUsage` is a pure
 * function over the calls, so the rollup is computed in-process — no second
 * SQL pass). An empty `calls` array (a run whose dispatch tasks have not yet
 * reached a terminal state, or a run with no dispatch tasks) is a valid
 * payload, not an error: `totals.byModel` is `{}` and `totalCalls` is 0.
 */
runsUsageRoutes.get('/runs/:runId/usage', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) {
    return fail(c, 400, 'invalid runId', { runId })
  }

  const run = await getRunUsage(runId)
  if (!run) return fail(c, 404, 'run not found', { runId })

  const calls = Array.isArray(run.agentDaemonCalls) ? run.agentDaemonCalls : []
  const { byModel, totalCalls } = aggregateUsage(calls)

  return ok(c, {
    run: {
      id: run.id,
      status: run.status,
      cost: run.cost,
      durationMs: run.durationMs,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    calls,
    totals: { byModel, totalCalls },
  })
})

/** Row shape for the agent-by-agent rollup in `/runs/:runId/usage/by-agent`. */
interface AgentRollupRow {
  agent_daemon_id: string | null
  calls: string
  total_duration_ms: number | null
}

/**
 * GET /runs/:runId/usage/by-agent — per-agent rollup for a run.
 *
 * Aggregates `agent_daemon_calls` at the SQL layer (no in-process walk) so a
 * fleet panel can show "this run called agent X N times for Y ms" without
 * pulling the full JSONB array. `agent_daemon_id` groups by the agent that
 * served each call; a call missing the id (legacy/half-populated) lands in the
 * null bucket. `calls` is `COUNT` → pg returns it as a string.
 *
 * Best-effort: a run with no `agent_daemon_calls` rows returns an empty array.
 * 404 when the run id matches no `runs` row (validated first so a mistyped id
 * is still a 400, not a silent empty result).
 */
runsUsageRoutes.get('/runs/:runId/usage/by-agent', async (c) => {
  const runId = c.req.param('runId')
  if (!UUID_RE.test(runId)) {
    return fail(c, 400, 'invalid runId', { runId })
  }

  // Existence check so a non-existent run is a 404, distinct from "run with
  // no calls" (200 + empty array).
  const { records: exist } = await runQuery<{ id: string }>(
    `SELECT id FROM runs WHERE id = $1`,
    [runId],
  )
  if (!exist[0]) return fail(c, 404, 'run not found', { runId })

  const { records } = await runQuery<AgentRollupRow>(
    `SELECT
        elem->>'agentDaemonId' AS agent_daemon_id,
        COUNT(*)::text AS calls,
        SUM(NULLIF((elem->>'durationMs')::numeric, 0))::bigint AS total_duration_ms
       FROM runs r, jsonb_array_elements(r.agent_daemon_calls) AS elem
      WHERE r.id = $1
      GROUP BY elem->>'agentDaemonId'
      ORDER BY total_duration_ms DESC NULLS LAST`,
    [runId],
  )

  return ok(c, {
    byAgent: records.map((r) => ({
      agentDaemonId: r.agent_daemon_id,
      calls: Number(r.calls),
      totalDurationMs: r.total_duration_ms != null ? Number(r.total_duration_ms) : null,
    })),
  })
})
