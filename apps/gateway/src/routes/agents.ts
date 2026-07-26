import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

/**
 * `/api/v1/agents/*` — Agent catalogue read API aligned to the v0.3 design
 * (plan v0.3-M9.1 / 后端契约 1; source of truth: `design/js/agents-data.js`).
 *
 * The Agents 管理页 + agent-detail 页 render the heterogeneous agent fleet.
 * Their field model is the design's `agents-data.js` single-agent object:
 *   id / name / kind / roles[] / instructions / skills[] / visibility /
 *   concurrency / model / runtime / owner / activity[{total,ok,fail}] /
 *   status / availability / summary (the M9.1 acceptance set), plus the
 *   design's run-context fields (run / flow / load / cost / progress /
 *   elapsed / inputSchema / outputSchema / created / lastActiveDays /
 *   runCount / failCount / logs).
 *
 * The data lives in the platform-owned `agents` table (created by the
 * in-repo domain migration `CreateDomainTables1720000008000`): one row per
 * agent with the design's editorial fields stored 1:1 as top-level columns
 * (`instructions`, `skills`, `visibility`, `concurrency`, `model`,
 * `runtime`, `owner_id`, `status`, `availability`, `activity`, `roles`).
 * `summary` + the I/O schemas are added as top-level TEXT columns by the
 * companion migration `AddAgentsCapabilityFields1720000008001` so the
 * response aligns 1:1 with the design's field names (not nested under a
 * JSONB descriptor). `owner` resolves to a human display name via a LEFT JOIN
 * on `workspace_members(member_id)`; an owner with no member row surfaces as
 * the raw `owner_id` text (never blank — the design's `负责人` prop-row
 * always renders a value).
 *
 * This is a *new* gateway-owned read surface — it is NOT the legacy dispatch
 * `/api/v1/dispatch/agents/*` proxy (which returns the snake_case
 * `agent_daemons` join). It currently has **no consumer**: the console's
 * agent-detail page still dials the dispatch proxy
 * (`/api/v1/dispatch/agents/:id`), and the agents list page still dials
 * `/api/v1/dispatch/agents`. The console will migrate to this route under
 * M5; until then these routes are read by the acceptance test only. (Consumer
 * migration tracked under M5.)
 *
 * All reads are parameterised raw SQL via `runQuery`, returning the standard
 * `{ success, data }` envelope. No filters are pushed into SQL — the catalogue
 * is small for MVP so kind/status/role filtering happens client-side, keeping
 * the SQL static (no dynamic WHERE building) and the routes trivial to audit.
 * ⚠️ The list route does NOT yet scope rows by workspace/membership (it returns
 * the full catalogue) — membership scoping lands with RBAC (follow-up, not
 * this task).
 *
 * `roles` / `skills` / `activity` are JSONB arrays (parsed by the pg driver),
 * so we forward them verbatim (never re-stringify, mirroring the dispatch
 * routes' handling).
 *
 * Auth: gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`,
 * same posture as the other gateway-owned reads; membership scoping is a
 * follow-up (RBAC). `x-run-id` is forwarded best-effort for trace correlation.
 */

export const agentsRoutes = new Hono()

const log = createLogger({ svc: 'gateway:agents' })

/** Standard envelope helpers (same shape as the rest of the gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/** UUID shape guard for path ids — 400 on a malformed id, not a 404. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Guard against an unbounded full-table scan if the fleet ever grows. */
const LIST_LIMIT = 500
// Fetch one more row than the cap so `truncated` is honest about *exactly* the
// cap (fetching `LIST_LIMIT` rows and flagging on `>=` would mis-flag a result
// set that is *exactly* the cap as truncated). `LIMIT LIST_LIMIT + 1` lets us
// distinguish "capped at LIST_LIMIT (more may exist)" from "the set is exactly
// LIST_LIMIT". The `id DESC` tiebreaker after `created_at DESC` keeps ordering
// deterministic when two rows share a timestamp (same-millisecond inserts),
// so the list page is stable across paginated re-queries.
const LIST_FETCH = LIST_LIMIT + 1

/**
 * snake_case row shape from pg for an `agents` row joined to its owner member.
 *
 * `roles` / `skills` / `activity` are JSONB arrays (parsed by the pg driver).
 * `owner_display` is the resolved human name from `workspace_members`; NULL
 * when the owner has no member row, in which case the route falls back to the
 * raw `owner_id` text so the design's `负责人` prop-row always renders a value.
 */
interface AgentRow {
  id: string
  name: string
  kind: string
  roles: unknown
  instructions: string
  skills: unknown
  visibility: string
  concurrency: number
  model: string
  runtime: string
  owner_id: string
  owner_display: string | null
  status: string
  availability: string
  activity: unknown
  summary: string
  input_schema: string
  output_schema: string
  daemon_id: string | null
  flow_id: string | null
  created_at: Date
  updated_at: Date
}

/** Coerce a JSONB value into a `string[]`, tolerating any stored shape. */
function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === 'string')
}

/** Coerce the JSONB `activity` into the design's `{total,ok,fail}[]` shape. */
function toActivity(raw: unknown): Array<{ total: number; ok: number; fail: number }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
    .map((b) => {
      const total = typeof b.total === 'number' && Number.isFinite(b.total) ? b.total : 0
      const fail = typeof b.fail === 'number' && Number.isFinite(b.fail) ? b.fail : 0
      // `ok` is stored explicitly when present; otherwise derive `total - fail`
      // (the design's `buckets()` helper sets `ok = total - fail`, so the two
      // are always consistent — deriving keeps the contract honest if a row
      // was written with only `total` + `fail`).
      const ok =
        typeof b.ok === 'number' && Number.isFinite(b.ok) ? b.ok : Math.max(0, total - fail)
      return { total, ok, fail }
    })
}

/** ISO string for a pg `timestamptz` that arrives as a Date or string. */
function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/**
 * Map a raw `agents` row to the design's single-agent object shape
 * (`design/js/agents-data.js`).
 *
 * The design's derived fields (`runCount` / `failCount`) are stamped here from
 * `activity` exactly as `agents-data.js:228-231` stamps them client-side — the
 * 30-day total run count + total fail count. `lastActiveDays` is not tracked in
 * the schema today (no "last activity" column); it defaults to 0 (active today)
 * which is the honest placeholder until a daemon-heartbeat rollup lands. The
 * run-context fields (`run` / `flow` / `load` / `cost` / `progress` / `elapsed`)
 * are nullable placeholders: they depend on the live dispatch task, which the
 * `agents` row does not join today — M5 wires them from the latest
 * `dispatch_tasks` row. They are present (nullable) so the shape matches the
 * design 1:1; the detail page renders them as `—` until M5.
 */
function toAgentDto(row: AgentRow): Record<string, unknown> {
  const activity = toActivity(row.activity)
  const runCount = activity.reduce((s, b) => s + b.total, 0)
  const failCount = activity.reduce((s, b) => s + b.fail, 0)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    roles: toStringArray(row.roles),
    instructions: row.instructions,
    skills: toStringArray(row.skills),
    visibility: row.visibility,
    concurrency: row.concurrency,
    model: row.model,
    runtime: row.runtime,
    owner: row.owner_display ?? row.owner_id,
    activity,
    status: row.status,
    availability: row.availability,
    summary: row.summary,
    // Run-context fields (design L25-26). Nullable placeholders until M5 joins
    // the latest dispatch_tasks row; present so the shape matches design 1:1.
    region: null,
    daemon: row.daemon_id ?? null,
    run: null,
    flow: row.flow_id ?? null,
    load: 0,
    cost: null,
    progress: 0,
    elapsed: null,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    created: toIso(row.created_at),
    lastActiveDays: 0,
    runCount,
    failCount,
  }
}

/** Shared column list + owner-member LEFT JOIN for list + detail queries. */
const AGENT_COLUMNS = `
  a.id, a.name, a.kind, a.roles, a.instructions, a.skills,
  a.visibility, a.concurrency, a.model, a.runtime, a.owner_id,
  a.status, a.availability, a.activity,
  a.summary, a.input_schema, a.output_schema,
  a.daemon_id, a.flow_id, a.created_at, a.updated_at,
  m.display_name AS owner_display
`

/**
 * GET /api/v1/agents — list agents (design-aligned shape), newest-first.
 *
 * Returns `{ agents, truncated }`. The list mirrors `window.OD_AGENTS` from
 * `agents-data.js` (one design-shaped object per row) so the agents page can
 * render directly off this payload. `truncated` is true only when the
 * LIST_LIMIT cap was overflowed (the query fetches one past the cap to
 * distinguish "exactly the cap, maybe no more" from "capped, more may exist";
 * the catalogue is small for MVP, so the flag stays false in practice — it
 * keeps the contract honest if the fleet ever grows past the cap).
 */
agentsRoutes.get('/', async (c) => {
  let rows: AgentRow[]
  try {
    const { records } = await runQuery<AgentRow>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN workspace_members m
           ON m.workspace_id = a.workspace_id AND m.member_id = a.owner_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $1`,
      [LIST_FETCH],
    )
    rows = records
  } catch (err) {
    // The agents table may not exist yet on a fresh DB before the domain
    // migration runs; surface a 502 (infrastructure) rather than a 500 leaking
    // the pg error stack (which can carry the connection string).
    log.error('agents list query failed', { error: String(err) })
    return fail(c, 502, 'agents list failed')
  }

  // If we fetched LIST_LIMIT + 1 rows, the cap was hit — drop the overflow row
  // and flag `truncated` so the caller knows more rows may exist. Fetching one
  // past the cap (rather than flagging on `rows.length >= LIST_LIMIT`) keeps
  // `truncated` honest at exactly the cap: a result set of exactly LIST_LIMIT
  // rows is *not* truncated (there may be no more), only a set that overflows
  // the cap is.
  const truncated = rows.length > LIST_LIMIT
  const visible = truncated ? rows.slice(0, LIST_LIMIT) : rows

  return ok(c, {
    agents: visible.map(toAgentDto),
    truncated,
  })
})

/**
 * GET /api/v1/agents/:id — full agent detail (design-aligned shape).
 *
 * Returns the design's single-agent object (the same shape the list emits, per
 * `agents-data.js`). 400 on a malformed id, 404 when no row matches. The
 * detail page reads this one object + the sibling `GET /agents/:id/logs` route
 * for the activity tab's recent-log list.
 */
agentsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid agent id', { id })
  }

  let row: AgentRow | null
  try {
    const { records } = await runQuery<AgentRow>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN workspace_members m
           ON m.workspace_id = a.workspace_id AND m.member_id = a.owner_id
        WHERE a.id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('agent detail query failed', { id, error: String(err) })
    return fail(c, 502, 'agent detail failed')
  }

  if (!row) {
    return fail(c, 404, 'agent not found', { id })
  }

  return ok(c, { agent: toAgentDto(row) })
})
