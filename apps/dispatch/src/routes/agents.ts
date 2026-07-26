import { Hono } from 'hono'
import { runQuery } from '@dagents/db'
import { ok, fail } from '../app.js'

/**
 * Agent catalogue read routes (M5a.2 / P1.10.T4).
 *
 * The Agents 管理页 browses the heterogeneous agent fleet. The data lives in
 * three tables this server already owns (see daemons.ts / tasks.ts):
 *   - `agent_daemons`  — one row per registered agent (kind, capability
 *     descriptor, visibility). `kind` is free TEXT (claude / codex / …).
 *   - `daemons`        — the host daemon serving an agent (status, heartbeat,
 *     capabilities tags). Joined 1:1 via `agent_daemons.daemon_id`.
 *   - `dispatch_tasks` — the work queue. The *latest* task per agent carries
 *     run_id / status / usage / duration for the list row + drawer; the recent
 *     task history feeds the resource sparkline + cost rollup.
 *   - `dispatch_task_events` — streamed message/progress per task → the drawer
 *     log stream.
 *
 * All three endpoints are read-only GETs with parameterised raw SQL, returning
 * the standard `{ success, data }` envelope (`ok`/`fail` from app.ts). No
 * filters are pushed into SQL — the catalogue is small for MVP (million-fleet
 * scale is explicitly out of scope, see plan §M5a.2) so kind/status/role/region
 * filtering happens client-side over the fetched list. This keeps the SQL
 * static (no dynamic WHERE building) and the routes trivial to audit.
 *
 * `capability_descriptor`, `usage`, and event `payload` are JSONB — the pg
 * driver already parses them to objects, so we forward them verbatim (never
 * re-stringify, mirroring tasks.ts's GET handling).
 */

export const agentsRoutes = new Hono()

/** Guard against an unbounded full-table scan if the fleet ever grows. */
const LIST_LIMIT = 500
/** Cap on recent-task history per agent (sparkline + cost rollup). */
const DETAIL_TASK_LIMIT = 50
/** Cap on log lines returned for the drawer stream. */
const LOG_LIMIT = 200

/** Row shape for the list join (snake_case from pg; mapped client-side). */
interface AgentListRow {
  id: string
  name: string
  kind: string
  capability_descriptor: unknown
  executable_path: string | null
  visibility: string | null
  created_at: Date
  daemon_label: string | null
  daemon_status: string | null
  last_heartbeat_at: Date | null
  daemon_capabilities: unknown
  task_id: string | null
  run_id: string | null
  task_status: string | null
  usage: unknown
  duration_ms: number | null
  task_created_at: Date | null
  finished_at: Date | null
}

/** Row shape for an agent's recent task history. */
interface TaskHistoryRow {
  id: string
  run_id: string
  status: string
  usage: unknown
  duration_ms: number | null
  created_at: Date
  finished_at: Date | null
}

/** Row shape for a dispatch task event (log stream). */
interface EventRow {
  kind: string
  seq: number
  payload: unknown
  created_at: Date
}

/**
 * GET /agents — list agents with their daemon + latest-task summary.
 *
 * The LATERAL join picks the most recent `dispatch_tasks` row per agent in one
 * pass (no correlated subquery in SELECT, no N+1). `LEFT JOIN` keeps agents
 * with no tasks yet (they surface as idle). Ordered newest-agent-first so a
 * freshly registered agent lands on top.
 */
agentsRoutes.get('/agents', async (c) => {
  const { records } = await runQuery<AgentListRow>(
    `SELECT ad.id, ad.name, ad.kind, ad.capability_descriptor,
            ad.executable_path, ad.visibility, ad.created_at,
            d.label AS daemon_label, d.status AS daemon_status,
            d.last_heartbeat_at, d.capabilities AS daemon_capabilities,
            t.id AS task_id, t.run_id, t.status AS task_status,
            t.usage, t.duration_ms, t.created_at AS task_created_at,
            t.finished_at
       FROM agent_daemons ad
       LEFT JOIN daemons d ON d.id = ad.daemon_id
       LEFT JOIN LATERAL (
         SELECT * FROM dispatch_tasks dt
         WHERE dt.agent_daemon_id = ad.id
         ORDER BY dt.created_at DESC LIMIT 1
       ) t ON true
       ORDER BY ad.created_at DESC
       LIMIT $1`,
    [LIST_LIMIT],
  )

  return ok(c, { agents: records, truncated: records.length >= LIST_LIMIT })
})

/**
 * GET /agents/:id — full detail: the agent + its daemon + recent task history.
 *
 * The list row's latest-task is enough for the list/kanban; the drawer also
 * wants a sparkline (recent durations) and a cost rollup, so we return the
 * last `DETAIL_TASK_LIMIT` tasks ordered newest-first. The client derives the
 * sparkline + cost from that history.
 *
 * `runs.agent_daemon_calls` is the spec's run→agent link, but it is empty today
 * (M6.2 populates it). We query it best-effort so the drawer can show bound
 * runs the moment they appear; absence is not an error.
 */
agentsRoutes.get('/agents/:id', async (c) => {
  const id = c.req.param('id')

  const { records: agentRows } = await runQuery<AgentListRow>(
    `SELECT ad.id, ad.name, ad.kind, ad.capability_descriptor,
            ad.executable_path, ad.visibility, ad.created_at,
            d.label AS daemon_label, d.status AS daemon_status,
            d.last_heartbeat_at, d.capabilities AS daemon_capabilities,
            t.id AS task_id, t.run_id, t.status AS task_status,
            t.usage, t.duration_ms, t.created_at AS task_created_at,
            t.finished_at
       FROM agent_daemons ad
       LEFT JOIN daemons d ON d.id = ad.daemon_id
       LEFT JOIN LATERAL (
         SELECT * FROM dispatch_tasks dt
         WHERE dt.agent_daemon_id = ad.id
         ORDER BY dt.created_at DESC LIMIT 1
       ) t ON true
      WHERE ad.id = $1`,
    [id],
  )
  const agent = agentRows[0]
  if (!agent) return fail(c, 404, 'agent not found', { agentId: id })

  const { records: tasks } = await runQuery<TaskHistoryRow>(
    `SELECT id, run_id, status, usage, duration_ms, created_at, finished_at
       FROM dispatch_tasks
      WHERE agent_daemon_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [id, DETAIL_TASK_LIMIT],
  )

  // Best-effort runs lookup. `agent_daemon_calls` is a JSONB array of
  // `{ agentDaemonId }` (spec §5.3); the @> containment match finds any run
  // that called this agent. Wrapped in a try — a schema/column drift should
  // never 500 the whole detail endpoint; an empty list is the safe fallback.
  let runs: { id: string; identifier: string; status: string; cost: string }[] = []
  try {
    const { records } = await runQuery<{ id: string; identifier: string; status: string; cost: string }>(
      `SELECT id, identifier, status, cost::text AS cost
         FROM runs
        WHERE agent_daemon_calls @> $1::jsonb
        ORDER BY created_at DESC
        LIMIT 20`,
      [JSON.stringify([{ agentDaemonId: id }])],
    )
    runs = records
  } catch {
    // runs table / column not yet present, or JSONB shape mismatch → no runs.
    runs = []
  }

  return ok(c, { agent, tasks, runs })
})

/**
 * Map a dispatch_task_event payload to a drawer log line.
 *
 * `payload` is an `AgentEvent` (contracts `AgentEvent` union): text / thinking
 * / tool-use / tool-result / status / log / error. We collapse it to the
 * `{ ts, level, msg }` shape the `.log` CSS expects (`level` ∈
 * info/ok/warn/err). `error`→err, `status`→ok, `log`→info, `tool-use`→info,
 * default→info. The message prefers `content` (text/log/thinking/error),
 * falls back to `output` (tool-result), then `status` (status), then a generic
 * label.
 */
function eventToLogLine(row: EventRow): { ts: string; level: string; msg: string } {
  const p = (row.payload ?? {}) as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : ''
  const level =
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
  return { ts: row.created_at.toISOString(), level, msg }
}

/**
 * GET /agents/:id/logs — recent log lines for an agent's tasks.
 *
 * Joins `dispatch_task_events` → `dispatch_tasks` on the agent's tasks and
 * returns the newest `LOG_LIMIT` lines. Ordered newest-first at the SQL layer;
 * the drawer renders them top-down (oldest-on-top) by reversing client-side.
 */
agentsRoutes.get('/agents/:id/logs', async (c) => {
  const id = c.req.param('id')

  // 404 if the agent itself doesn't exist, so the drawer can distinguish
  // "no agent" from "agent with no logs".
  const { records: existRows } = await runQuery<{ id: string }>(
    `SELECT id FROM agent_daemons WHERE id = $1`,
    [id],
  )
  if (!existRows[0]) return fail(c, 404, 'agent not found', { agentId: id })

  const { records } = await runQuery<EventRow>(
    `SELECT e.kind, e.seq, e.payload, e.created_at
       FROM dispatch_task_events e
       JOIN dispatch_tasks t ON t.id = e.task_id
      WHERE t.agent_daemon_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [id, LOG_LIMIT],
  )

  return ok(c, { logs: records.map(eventToLogLine) })
})
