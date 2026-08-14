import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { findAgentReferences } from '@dagents/workflow'

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
 * Auth: none — the gateway runs open (local-machine service); membership
 * scoping is a non-goal. `x-run-id` is forwarded best-effort for trace correlation.
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

/** Cap on recent-task history per agent (sparkline + cost rollup). */
const DETAIL_TASK_LIMIT = 50
/** Cap on log lines returned for the activity tab's log stream. */
const LOG_LIMIT = 200

/** Default workspace for local-dev / no-SSO mode (inline-executor path). */
const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

/**
 * snake_case row shape from pg for an `agents` row joined to its owner member.
 *
 * `roles` / `skills` / `activity` are JSONB arrays (parsed by the pg driver).
 * `owner_display` is the resolved human name from `workspace_members`; NULL
 * when the owner has no member row, in which case the route falls back to the
 * raw `owner_id` text so the design's `负责人` prop-row always renders a value.
 */
interface AgentRow {
  // --- agents table (design source of truth, M9.1) ---
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
  // --- agent_daemons join (runtime registration, by shared id) ---
  ad_id: string | null
  ad_daemon_id: string | null
  capability_descriptor: unknown
  executable_path: string | null
  ad_visibility: string | null
  ad_created_at: Date | null
  // --- daemons join (runtime host) ---
  daemon_label: string | null
  daemon_status: string | null
  last_heartbeat_at: Date | null
  daemon_capabilities: unknown
  // --- dispatch_tasks LATERAL join (latest task) ---
  task_id: string | null
  run_id: string | null
  task_status: string | null
  usage: unknown
  duration_ms: number | null
  task_created_at: Date | null
  finished_at: Date | null
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
function toIso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/**
 * Parse the `capability_descriptor` JSONB into the design's `{ summary, tags,
 * inputSchema, outputSchema }` shape. Mirrors `parseCapability` in the
 * console's agents-catalog so the two sides agree on the descriptor layout.
 */
function parseCapability(raw: unknown): {
  summary: string
  tags: string[]
  inputSchema: string
  outputSchema: string
} {
  if (!raw || typeof raw !== 'object') {
    return { summary: '', tags: [], inputSchema: '', outputSchema: '' }
  }
  const c = raw as Record<string, unknown>
  return {
    summary: typeof c.summary === 'string' ? c.summary : '',
    tags: Array.isArray(c.tags) ? c.tags.filter((s): s is string => typeof s === 'string') : [],
    inputSchema: typeof c.inputSchema === 'string' ? c.inputSchema : '',
    outputSchema: typeof c.outputSchema === 'string' ? c.outputSchema : '',
  }
}

/** Derive a region label from the daemon's `capabilities` JSONB. */
function deriveRegion(caps: unknown): string {
  if (!Array.isArray(caps)) return '—'
  const found = caps.find(
    (c): c is Record<string, unknown> =>
      c !== null && typeof c === 'object' && typeof (c as Record<string, unknown>).region === 'string',
  )
  return found ? (found.region as string) : '—'
}

/** Elapsed ms for an in-flight task; null when not running or no task. */
function deriveElapsedMs(
  taskStatus: string | null,
  taskCreatedAt: Date | null,
  finishedAt: Date | null,
): number | null {
  if (!taskCreatedAt) return null
  const end = finishedAt ? finishedAt.getTime() : Date.now()
  const ms = end - taskCreatedAt.getTime()
  // Only count elapsed for tasks that are (or were) in flight; queued tasks
  // have no meaningful elapsed.
  return taskStatus && taskStatus !== 'queued' && Number.isFinite(ms) ? Math.max(0, ms) : null
}

/** Load bucket label from the latest task status + elapsed. */
function deriveLoad(taskStatus: string | null, elapsedMs: number | null): string {
  if (taskStatus === 'running') return elapsedMs != null ? '运行中' : '运行中'
  if (taskStatus === 'queued') return '排队'
  if (taskStatus === 'completed') return '空闲'
  if (taskStatus === 'failed') return '异常'
  return '空闲'
}

/** Cost rollup from the latest task's `usage` JSONB. */
function deriveCost(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const cost = u.cost
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null
}

/**
 * Map a raw `agents` row to the design's single-agent object shape
 * (`design/js/agents-data.js`).
 *
 * The design's derived fields (`runCount` / `failCount`) are stamped here from
 * `activity` exactly as `agents-data.js:228-231` stamps them client-side — the
 * 30-day total run count + total fail count. `lastActiveDays` is not tracked in
 * the schema today (no "last activity" column); it defaults to 0 (active today)
 * which is the honest placeholder until a daemon-heartbeat rollup lands.
 *
 * The run-context fields (`run` / `load` / `cost` / `progress` / `elapsed`)
 * are joined from `agent_daemons` + `daemons` + the latest `dispatch_tasks` row
 * (the same data the dispatch `/agents` route returns), so the agents page no
 * longer needs a separate dispatch read path. When an agent has no
 * `agent_daemons` row (e.g. an editor-only agent not yet registered with a
 * daemon), the runtime fields fall back to null/0 placeholders — matching the
 * pre-bridge behaviour.
 *
 * Snake_case runtime aliases (`daemon_label`, `task_status`, …) are emitted
 * alongside the camelCase design fields so the console's agents-catalog mapper
 * (which historically consumed the dispatch snake_case shape) can read this
 * payload without a rewrite.
 */
function toAgentDto(row: AgentRow): Record<string, unknown> {
  const activity = toActivity(row.activity)
  const runCount = activity.reduce((s, b) => s + b.total, 0)
  const failCount = activity.reduce((s, b) => s + b.fail, 0)
  const capability = parseCapability(row.capability_descriptor)
  const elapsedMs = deriveElapsedMs(row.task_status, row.task_created_at, row.finished_at)
  const daemon = row.ad_id ? row.ad_daemon_id ?? row.daemon_id ?? null : row.daemon_id ?? null

  // design camelCase fields (M9.1 acceptance set) — unchanged.
  // For inline-executor agents (agent_daemons row with executable_path but
  // no daemon_id), override availability to 'online' — the gateway can
  // spawn the CLI directly, no daemon process needed.
  const isInlineReady = !!(row.ad_id && row.executable_path && !row.ad_daemon_id)
  const availability = isInlineReady ? 'online' : row.availability

  const dto: Record<string, unknown> = {
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
    availability,
    summary: row.summary,
    // run-context (joined from dispatch tables; null/0 when no daemon bound).
    region: row.ad_id ? deriveRegion(row.daemon_capabilities) : null,
    daemon,
    run: row.run_id ?? null,
    flow: row.flow_id ?? null,
    load: row.ad_id ? deriveLoad(row.task_status, elapsedMs) : 0,
    cost: row.ad_id ? deriveCost(row.usage) : null,
    progress: 0,
    elapsed: elapsedMs,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    created: toIso(row.created_at) ?? '',
    lastActiveDays: 0,
    runCount,
    failCount,
  }

  // Runtime aliases consumed by the console agents-catalog mapper
  // (snake_case, matching the legacy dispatch shape). Emitted only when the
  // agent has an agent_daemons row so editor-only agents surface nulls rather
  // than fabricated dispatch data.
  dto.daemon_label = row.daemon_label ?? (isInlineReady ? 'inline' : null)
  // Inline-executor agents are always 'online' (gateway spawns directly).
  dto.daemon_status = row.daemon_status ?? (isInlineReady ? 'online' : null)
  dto.last_heartbeat_at = toIso(row.last_heartbeat_at)
  dto.daemon_capabilities = row.daemon_capabilities ?? null
  dto.task_id = row.task_id ?? null
  dto.run_id = row.run_id ?? null
  dto.task_status = row.task_status ?? null
  dto.usage = row.usage ?? null
  dto.duration_ms = row.duration_ms ?? null
  dto.task_created_at = toIso(row.task_created_at)
  dto.finished_at = toIso(row.finished_at)
  dto.elapsedMs = elapsedMs
  dto.capability = capability
  dto.capability_descriptor = row.capability_descriptor ?? null
  dto.executable_path = row.executable_path ?? null
  // `created_at` mirrors `created` as an ISO string for snake_case consumers.
  dto.created_at = toIso(row.created_at) ?? ''

  return dto
}

/** Shared column list + owner-member + runtime LEFT JOINs for list + detail. */
const AGENT_COLUMNS = `
  a.id, a.name, a.kind, a.roles, a.instructions, a.skills,
  a.visibility, a.concurrency, a.model, a.runtime, a.owner_id,
  a.status, a.availability, a.activity,
  a.summary, a.input_schema, a.output_schema,
  a.daemon_id, a.flow_id, a.created_at, a.updated_at,
  m.display_name AS owner_display,
  ad.id AS ad_id, ad.daemon_id AS ad_daemon_id,
  ad.capability_descriptor, ad.executable_path,
  ad.visibility AS ad_visibility, ad.created_at AS ad_created_at,
  d.label AS daemon_label, d.status AS daemon_status,
  d.last_heartbeat_at, d.capabilities AS daemon_capabilities,
  t.id AS task_id, t.run_id, t.status AS task_status,
  t.usage, t.duration_ms, t.created_at AS task_created_at, t.finished_at
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
         LEFT JOIN agent_daemons ad ON ad.id = a.id
         LEFT JOIN daemons d ON d.id = ad.daemon_id
         LEFT JOIN LATERAL (
           SELECT * FROM dispatch_tasks dt
            WHERE dt.agent_daemon_id = ad.id
            ORDER BY dt.created_at DESC LIMIT 1
         ) t ON true
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
         LEFT JOIN agent_daemons ad ON ad.id = a.id
         LEFT JOIN daemons d ON d.id = ad.daemon_id
         LEFT JOIN LATERAL (
           SELECT * FROM dispatch_tasks dt
            WHERE dt.agent_daemon_id = ad.id
            ORDER BY dt.created_at DESC LIMIT 1
         ) t ON true
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

  // Recent task history for the activity sparkline + cost rollup. Mirrors the
  // dispatch detail route's `tasks[]`. Best-effort: an agent without an
  // agent_daemons row (editor-only) yields an empty list, not an error.
  let tasks: Array<{
    id: string
    run_id: string
    status: string
    usage: unknown
    duration_ms: number | null
    created_at: string
    finished_at: string | null
  }> = []
  if (row.ad_id) {
    try {
      const { records: taskRows } = await runQuery<{
        id: string
        run_id: string
        status: string
        usage: unknown
        duration_ms: number | null
        created_at: Date
        finished_at: Date | null
      }>(
        `SELECT id, run_id, status, usage, duration_ms, created_at, finished_at
           FROM dispatch_tasks
          WHERE agent_daemon_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [row.ad_id, DETAIL_TASK_LIMIT],
      )
      tasks = taskRows.map((t) => ({
        id: t.id,
        run_id: t.run_id,
        status: t.status,
        usage: t.usage,
        duration_ms: t.duration_ms,
        created_at: toIso(t.created_at) ?? '',
        finished_at: toIso(t.finished_at),
      }))
    } catch (err) {
      log.error('agent detail tasks query failed', { id, error: String(err) })
    }
  }

  // Best-effort runs lookup (same shape/contract as the dispatch detail route).
  let runs: { id: string; identifier: string; status: string; cost: string }[] = []
  if (row.ad_id) {
    try {
      const { records } = await runQuery<{ id: string; identifier: string; status: string; cost: string }>(
        `SELECT id, identifier, status, cost::text AS cost
           FROM runs
          WHERE agent_daemon_calls @> $1::jsonb
          ORDER BY created_at DESC
          LIMIT 20`,
        [JSON.stringify([{ agentDaemonId: row.ad_id }])],
      )
      runs = records
    } catch {
      runs = []
    }
  }

  return ok(c, { agent: toAgentDto(row), tasks, runs })
})

/**
 * Reference shape for the delete-blocked response — one entry per flow that
 * embeds a Platform Agent node bound to the agent being deleted.
 */
interface AgentFlowReference {
  flowId: string
  flowName: string
  /** The canvas node instance ids referencing this agent. */
  nodeIds: string[]
}

/**
 * DELETE /api/v1/agents/:id — delete a platform agent, blocked while any flow
 * still references it via a Platform Agent node.
 *
 * The flow→agent reference is a JSONB string value inside `flows.flow_data`
 * (no DB-level FK), so deletion is guarded in application code: we scan every
 * flow's `flow_data` for Platform Agent nodes bound to this agent id and, if
 * any are found, return 409 with the reference list so the caller can update
 * or remove those nodes first. Only when no references remain is the agent
 * row deleted.
 *
 * Reference scanning is delegated to `@dagents/workflow` so the agent route
 * does not depend on the canvas node storage layout.
 *
 * 400 on a malformed id, 404 when no agent row matches, 409 when blocked by
 * references. On success returns `{ id, deleted: true }`.
 */
agentsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid agent id', { id })
  }

  // Scan flows for Platform Agent nodes referencing this agent. We pull the
  // minimal columns (id, name, flow_data) and resolve references in app code
  // — the catalogue of flows is small for MVP, and a jsonb_path_query-based
  // SQL filter would have to mirror the two storage layouts below, making it
  // harder to audit than a single typed pass.
  let flowRows: Array<{ id: string; name: string; flow_data: unknown }>
  try {
    const { records } = await runQuery<{ id: string; name: string; flow_data: unknown }>(
      `SELECT id, name, flow_data FROM flows`,
      [],
    )
    flowRows = records
  } catch (err) {
    log.error('agent delete: flows scan failed', { id, error: String(err) })
    return fail(c, 502, 'agent delete reference scan failed')
  }

  const references: AgentFlowReference[] = []
  for (const f of flowRows) {
    const nodeIds = findAgentReferences(f.flow_data, id)
    if (nodeIds.length > 0) {
      references.push({ flowId: f.id, flowName: f.name, nodeIds })
    }
  }

  if (references.length > 0) {
    return fail(c, 409, 'agent is referenced by one or more flows', {
      references,
      hint: 'Remove or rebind the Platform Agent nodes referencing this agent before deleting.',
    })
  }

  // No references — delete the agent row. RETURNING id lets us distinguish a
  // genuine 404 (no row) from a successful delete.
  try {
    const { records } = await runQuery<{ id: string }>(
      `DELETE FROM agents WHERE id = $1 RETURNING id`,
      [id],
    )
    if (!records[0]) {
      return fail(c, 404, 'agent not found', { id })
    }
  } catch (err) {
    log.error('agent delete failed', { id, error: String(err) })
    return fail(c, 502, 'agent delete failed')
  }

  // Also remove the matching agent_daemons row (shared-id bridge) so the
  // runtime registration does not linger as an orphan after the editor row is
  // gone. Best-effort: a missing agent_daemons row is not an error.
  try {
    await runQuery(`DELETE FROM agent_daemons WHERE id = $1`, [id])
  } catch (err) {
    log.warn('agent delete: agent_daemons cleanup failed', { id, error: String(err) })
  }

  log.info('agent deleted', { id })
  return ok(c, { id, deleted: true })
})

/**
 * PATCH /api/v1/agents/:id — update an agent's mutable fields.
 *
 * Currently supports `visibility` (e.g. 'archived', 'workspace', 'public'),
 * `name`, `instructions`, `model`, and `summary`. This is a thin update —
 * only the provided fields are written; omitted fields are left unchanged.
 *
 * 400 on a malformed id, 404 when no agent row matches.
 */
agentsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid agent id', { id })
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid JSON body')
  }

  // Whitelist updatable columns
  const allowed = new Map<string, string>([
    ['visibility', 'visibility'],
    ['name', 'name'],
    ['instructions', 'instructions'],
    ['model', 'model'],
    ['summary', 'summary'],
    ['status', 'status'],
    ['availability', 'availability'],
  ])

  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, col] of allowed) {
    if (key in body) {
      params.push(body[key])
      sets.push(`${col} = $${params.length}`)
    }
  }

  if (sets.length === 0) {
    return fail(c, 400, 'no updatable fields provided')
  }

  sets.push(`updated_at = NOW()`)
  params.push(id)

  try {
    const { records } = await runQuery<{ id: string }>(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    )
    if (!records[0]) {
      return fail(c, 404, 'agent not found', { id })
    }
  } catch (err) {
    log.error('agent patch failed', { id, error: String(err) })
    return fail(c, 502, 'agent update failed')
  }

  log.info('agent updated', { id, fields: Object.keys(body) })
  return ok(c, { id, updated: true })
})

/**
 * GET /api/v1/agents/:id/logs — recent log lines for an agent's tasks.
 *
 * Joins `dispatch_task_events` → `dispatch_tasks` on the agent's
 * `agent_daemons` row (shared-id bridge) and returns the newest `LOG_LIMIT`
 * lines as `{ ts, level, msg }`. Ordered newest-first at the SQL layer; the
 * drawer renders them top-down (oldest-on-top) by reversing client-side.
 * Mirrors the dispatch `GET /agents/:id/logs` contract so the console's logs
 * tab works without changes once it points at this route.
 */
agentsRoutes.get('/:id/logs', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid agent id', { id })
  }

  // 404 when the agent itself does not exist, so the drawer can distinguish
  // "no agent" from "agent with no logs". The logs themselves join
  // dispatch_tasks on agent_daemon_id, which under the shared-id bridge equals
  // the agents.id — so we query with the request id directly.
  try {
    const { records } = await runQuery<{ id: string }>(`SELECT id FROM agents WHERE id = $1`, [id])
    if (!records[0]) {
      return fail(c, 404, 'agent not found', { id })
    }
  } catch (err) {
    log.error('agent logs: agent lookup failed', { id, error: String(err) })
    return fail(c, 502, 'agent logs failed')
  }

  let logs: Array<{ ts: string; level: string; msg: string }>
  try {
    const { records } = await runQuery<{
      kind: string
      seq: number
      payload: unknown
      created_at: Date
    }>(
      `SELECT e.kind, e.seq, e.payload, e.created_at
         FROM dispatch_task_events e
         JOIN dispatch_tasks t ON t.id = e.task_id
        WHERE t.agent_daemon_id = $1
        ORDER BY e.created_at DESC
        LIMIT $2`,
      [id, LOG_LIMIT],
    )
    logs = records.map(eventToLogLine)
  } catch (err) {
    log.error('agent logs query failed', { id, error: String(err) })
    return fail(c, 502, 'agent logs failed')
  }

  return ok(c, { logs })
})

/**
 * Map a dispatch_task_event payload to a drawer log line — same shape/contract
 * as the dispatch route's `eventToLogLine` so the console logs tab is
 * unchanged. `payload` is an `AgentEvent` union; collapsed to `{ts,level,msg}`.
 */
function eventToLogLine(row: { kind: string; seq: number; payload: unknown; created_at: Date }): {
  ts: string
  level: string
  msg: string
} {
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
 * POST /api/v1/agents — create a platform agent (editor row + runtime row).
 *
 * Writes the design-aligned `agents` row (the editor fields the detail page
 * renders) and, when a `daemonId` is supplied, a matching `agent_daemons` row
 * under the same id (the shared-id bridge) so the agent is both editable and
 * runnable. Without a `daemonId` the agent is created editor-only and can be
 * bound to a daemon later.
 *
 * This is the missing write entry point for the `agents` table — previously
 * the table had no production writer, so Platform Agent canvas dropdown and the
 * agents page had no data source. Returns `{ id }` on success.
 */
const createAgentSchema = z.object({
  name: z.string().min(1).max(128),
  // Keep in sync with AgentType (packages/contracts/src/agent.ts)
  // plus 'prompt' and 'remote' for legacy/internal use.
  kind: z.enum([
    'prompt', 'claude', 'codex', 'copilot', 'opencode', 'openclaw',
    'hermes', 'gemini', 'pi', 'cursor', 'kimi', 'kiro',
    'antigravity', 'codebuddy', 'qoder', 'qwen',
    'deveco', 'grok', 'traecli', 'remote',
  ]),
  workspaceId: z.string().uuid().optional().default(DEFAULT_WORKSPACE_ID),
  ownerId: z.string().min(1).max(128).optional().default('local'),
  daemonId: z.string().uuid().optional().nullable(),
  instructions: z.string().max(8000).optional().default(''),
  skills: z.array(z.string()).optional().default([]),
  roles: z.array(z.string()).optional().default([]),
  model: z.string().max(128).optional().default(''),
  runtime: z.string().max(128).optional().default(''),
  visibility: z.enum(['workspace', 'public']).optional().default('workspace'),
  concurrency: z.number().int().min(1).max(64).optional().default(1),
  status: z.enum(['running', 'queued', 'idle', 'failed', 'paused']).optional().default('idle'),
  availability: z.string().max(32).optional().default('offline'),
  summary: z.string().max(2000).optional().default(''),
  inputSchema: z.string().max(4000).optional().default(''),
  outputSchema: z.string().max(4000).optional().default(''),
  executablePath: z.string().max(512).optional().nullable(),
})

agentsRoutes.post('/', async (c) => {
  let parsed: z.infer<typeof createAgentSchema>
  try {
    parsed = createAgentSchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid create body', { detail: String(err) })
  }

  // When a daemonId is supplied, verify the daemon exists before inserting
  // (the agent_daemons FK would 500 otherwise; we want a clean 404).
  if (parsed.daemonId) {
    try {
      const { records } = await runQuery<{ id: string }>(`SELECT id FROM daemons WHERE id = $1`, [
        parsed.daemonId,
      ])
      if (!records[0]) {
        return fail(c, 404, 'daemon not found', { daemonId: parsed.daemonId })
      }
    } catch (err) {
      log.error('agent create: daemon lookup failed', { error: String(err) })
      return fail(c, 502, 'agent create failed')
    }
  }

  const id = randomUUID()

  try {
    await runQuery(
      `INSERT INTO agents (id, workspace_id, name, kind, roles, instructions, skills,
                           visibility, concurrency, model, runtime, owner_id,
                           status, availability, activity, summary, input_schema, output_schema,
                           daemon_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb,
               $8, $9, $10, $11, $12,
               $13, $14, '[]'::jsonb, $15, $16, $17,
               $18)`,
      [
        id,
        parsed.workspaceId,
        parsed.name,
        parsed.kind,
        JSON.stringify(parsed.roles),
        parsed.instructions,
        JSON.stringify(parsed.skills),
        parsed.visibility,
        parsed.concurrency,
        parsed.model,
        parsed.runtime,
        parsed.ownerId,
        parsed.status,
        parsed.availability,
        parsed.summary,
        parsed.inputSchema,
        parsed.outputSchema,
        parsed.daemonId ?? null,
      ],
    )
  } catch (err) {
    log.error('agent create: agents insert failed', { error: String(err) })
    return fail(c, 422, 'create failed', { detail: String(err) })
  }

  // Bridge row: register the agent with a daemon under the same id so the
  // runtime read path (agent_daemons join) lights up immediately. Best-effort
  // — a failure here does not undo the editor row; the agent is still usable
  // for flow orchestration (Platform Agent node reads the agents table).
  //
  // Two paths create the bridge row:
  //   1. daemonId supplied → full registration (daemon-managed agent)
  //   2. executablePath supplied, no daemonId → inline-executor agent
  //      (gateway spawns the CLI directly, no daemon process needed).
  //      We create the agent_daemons row WITHOUT a daemon_id so the
  //      inline-executor can find the agent by id + read executable_path.
  if (parsed.daemonId || parsed.executablePath) {
    try {
      const capabilityDescriptor = {
        name: parsed.name,
        summary: parsed.summary,
        tags: parsed.roles,
        inputSchema: parsed.inputSchema,
        outputSchema: parsed.outputSchema,
      }
      await runQuery(
        `INSERT INTO agent_daemons (id, name, kind, daemon_id, capability_descriptor,
                                    executable_path, visibility, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          parsed.name,
          parsed.kind,
          parsed.daemonId ?? null,
          JSON.stringify(capabilityDescriptor),
          parsed.executablePath ?? null,
          parsed.visibility,
          parsed.workspaceId,
        ],
      )
    } catch (err) {
      log.warn('agent create: agent_daemons bridge insert failed', { id, error: String(err) })
    }
  }

  // For inline-executor agents (no daemonId but has executablePath), mark
  // availability as 'online' since the gateway can spawn the CLI directly —
  // no daemon process needed.  Without this, the agent shows as 'offline'
  // even though it is immediately usable via inline execution.
  const finalAvailability = (!parsed.daemonId && parsed.executablePath)
    ? 'online'
    : parsed.availability

  try {
    await runQuery(
      `UPDATE agents SET availability = $1 WHERE id = $2`,
      [finalAvailability, id],
    )
  } catch {
    // best-effort — the default in the INSERT already covers the offline case
  }

  log.info('agent created', { id, daemonId: parsed.daemonId ?? null })
  return ok(c, { id })
})
