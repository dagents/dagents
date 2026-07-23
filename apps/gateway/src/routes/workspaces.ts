import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@mil/db'
import { createLogger } from '@mil/shared'
import {
  fetchFlowiseJson,
  FlowiseFetchError,
  flowiseChatflowSchema,
} from './workspace-flowise.js'

/**
 * `/api/v1/workspaces/*` — Workspace project read API (plan M5b.1 / P1.10.T6).
 *
 * The Workspace 项目对话页 is the per-project collaboration surface. The
 * gateway is the single choke point for the platform's own tables, so it owns
 * the read side here too. This module exposes the four reads the console view
 * drives (all GET, all parameterised raw SQL via `runQuery`):
 *
 *   GET /api/v1/workspaces                      → project list (active by default)
 *   GET /api/v1/workspaces/:id                  → one project (members + flows)
 *   GET /api/v1/workspaces/:id/threads          → conversation thread (runs
 *                                                  scoped to the workspace)
 *   GET /api/v1/workspaces/:id/quota            → monthly quota caps + used
 *
 * ## Conversation thread = run history
 *
 * There is NO separate `workspace_threads` table. The conversation thread IS
 * the `runs` scoped to the workspace: each run is one conversation turn
 * carrying the OTel-threaded `run_id` (M6.1), so the thread is end-to-end
 * traceable without a parallel id space. `runs.workspace_id` is the scoping
 * key. `runs.input` / `runs.output` are JSONB; the gateway forwards them
 * verbatim so the view can render the user question + agent answer + any
 * produced artifacts. A run with no `workspace_id` (platform-scoped) never
 * appears in a project thread.
 *
 * ## Linked flows
 *
 * `workspace_flows.pipeline_id` is the Flowise flow id. The gateway enriches
 * each linked flow with its live Flowise name/status (via the read-only
 * passthrough `fetchFlowiseJson`) so the meta panel renders the flow's current
 * state rather than a stale local copy. A Flowise fetch failure (key unset /
 * upstream down) degrades gracefully: the flow row still lists with name =
 * pipeline_id and status `unknown`, so the panel never blanks on a Flowise
 * outage.
 *
 * ## Artifacts
 *
 * "产物" (produced artifacts) are aggregated from `runs.artifact_uri` for the
 * workspace — counts by kind (report / dataset / patch). `runs.artifact_uri`
 * is an S3 URI set when M4 archived one (a run with no artifact contributes to
 * no count). We classify by the URI's extension: `.csv` → dataset, `.patch` →
 * patch, everything else with a basename (`.json`, `.md`, …) → report. A run
 * whose `artifact_uri` is null — the common case, since only completed+archived
 * runs get one — counts as nothing, so the totals reflect real archived
 * artifacts rather than every run in the project. (Classification by `output`
 * shape was considered and dropped: `runs.output` is opaque JSONB with no
 * stable `kind` field, and the archived filename is the one signal that maps
 * cleanly to the design's report/dataset/patch buckets.)
 *
 * ## Auth
 *
 * Gated by the SSO session middleware (M5b.4 / P1.4.T2): under
 * `REQUIRE_LOGIN=1` a request without a valid `mil_session` cookie 401s. The
 * middleware does not yet scope rows to the caller's memberships — a logged-in
 * user sees every project; membership-scoped reads (RBAC) are a follow-up.
 * Documented per-route.
 *
 * `x-run-id` is forwarded best-effort so a console→gateway hop stays in the
 * same trace (M6.1); these reads don't generate one (no run context), but
 * threading the caller's keeps correlation consistent.
 *
 * Standard envelope (CLAUDE.md API convention): { success, data?, error? }.
 */

export const workspaceRoutes = new Hono()

const log = createLogger({ svc: 'gateway:workspaces' })

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

const listQuerySchema = z.object({
  // `archived=true` includes archived projects (hidden by default). The design
  // surfaces archived projects under a filter; the default list is active only.
  includeArchived: z.enum(['true', 'false']).optional(),
  // Caps the list so a bare GET can't pull an unbounded set. 200 is a generous
  // page for a project browse; the console paginates client-side.
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

/** snake_case row shape from pg for a workspaces list row. */
interface WorkspaceListRow {
  id: string
  name: string
  glyph: string | null
  description: string | null
  status: string
  member_count: string | null
  flow_count: string | null
  created_at: Date
}

/** snake_case row shape from pg for one workspace + its members + flows. */
interface WorkspaceMemberRow {
  id: string
  member_id: string
  display_name: string | null
  initial: string | null
  role: string
}
interface WorkspaceFlowRow {
  id: string
  pipeline_id: string
  note: string | null
}

/** snake_case row shape from pg for a thread (run) row. */
interface ThreadRow {
  id: string
  identifier: string
  pipeline_id: string
  status: string
  input: unknown
  output: unknown
  artifact_uri: string | null
  created_by_user_id: string | null
  trace_id: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

/** A quota facet: used vs cap (the meta panel renders a bar). */
export interface QuotaFacet {
  used: number
  cap: number
  unit?: string
}

/** The quota blob shape the meta panel renders (cost / runs / tokens). */
export interface WorkspaceQuota {
  cost?: QuotaFacet
  runs?: QuotaFacet
  tokens?: QuotaFacet
}

/**
 * Normalize a jsonb quota blob into the `WorkspaceQuota` the view renders.
 * `workspaces.quota` is editorial jsonb; its shape is `{ cost, runs, tokens }`
 * where each facet is `{ used, cap, unit? }`. Unknown / malformed facets are
 * dropped (not fatal) so a hand-edited row can't crash the read.
 */
function normalizeQuota(raw: unknown): WorkspaceQuota {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const facet = (v: unknown): QuotaFacet | undefined => {
    if (typeof v !== 'object' || v === null) return undefined
    const f = v as Record<string, unknown>
    const used = typeof f.used === 'number' ? f.used : 0
    const cap = typeof f.cap === 'number' ? f.cap : 0
    const unit = typeof f.unit === 'string' ? f.unit : undefined
    return { used, cap, unit }
  }
  const out: WorkspaceQuota = {}
  const cost = facet(obj.cost)
  if (cost) out.cost = cost
  const runs = facet(obj.runs)
  if (runs) out.runs = runs
  const tokens = facet(obj.tokens)
  if (tokens) out.tokens = tokens
  return out
}

/**
 * Enrich a list of linked pipeline ids with their live Flowise name + status.
 * Best-effort: a Flowise fetch failure degrades the row to name = pipelineId +
 * status `unknown` rather than blanking the panel. Fetches run concurrently
 * (`Promise.allSettled`) so a workspace with several linked flows isn't
 * serialized N×RTT against Flowise — one slow/failed flow can't stall the
 * others, and each settles to its own degraded row on a miss. Returns a map
 * pipelineId → { name, status, updatedAt }.
 */
async function enrichLinkedFlows(
  pipelineIds: readonly string[],
): Promise<Record<string, { name: string; status: string; updatedAt: string | null }>> {
  const out: Record<string, { name: string; status: string; updatedAt: string | null }> = {}
  if (pipelineIds.length === 0) return out

  const settled = await Promise.allSettled(
    pipelineIds.map((pid) =>
      fetchFlowiseJson<unknown>(`/api/v1/chatflows/${encodeURIComponent(pid)}`).then((row) => {
        const parsed = flowiseChatflowSchema.safeParse(row)
        if (parsed.success) {
          return {
            pid,
            name: parsed.data.name,
            // Flowise `deployed` (true → deployed/idle) is the closest status
            // signal without pulling executions; the flows browse page colors by
            // the latest execution, but here a lightweight name+deployed read is
            // enough for the meta card. `unknown` when absent.
            status: parsed.data.deployed === false ? 'paused' : 'idle',
            updatedAt: toIso(parsed.data.updatedDate),
          }
        }
        return { pid, name: pid, status: 'unknown' as const, updatedAt: null }
      }),
    ),
  )

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      const { pid, ...rest } = result.value
      out[pid] = rest
    } else {
      // A rejected promise means `fetchFlowiseJson` threw (503 = key not
      // configured; 502 = upstream down / 404 on the flow). Degrade gracefully:
      // we can't map it back to a pid here, so log the miss — the caller still
      // gets the pipelineId as the name from the `?? f.pipeline_id` fallback in
      // the detail route. Resolve all pids that didn't fulfill explicitly so
      // the map is complete (the allSettled order matches the input order).
      log.warn('flowise flow enrich failed', {
        error: result.reason instanceof FlowiseFetchError ? result.reason.status : String(result.reason),
      })
    }
  }

  // Fill any pid that never produced a fulfilled entry (rejected above) with
  // the degraded shape so the detail route's `enriched[f.pipeline_id]` lookup
  // always hits. Iterating pipelineIds (not `settled`) keeps the pid↔result
  // mapping by index, which the rejection branch above can't recover.
  for (let i = 0; i < pipelineIds.length; i++) {
    const pid = pipelineIds[i]!
    if (!out[pid]) {
      out[pid] = { name: pid, status: 'unknown', updatedAt: null }
    }
  }
  return out
}

function toIso(d: string | Date | null): string | null {
  if (d === null || d === undefined) return null
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/** List workspaces (active by default), newest-first, with member/flow counts. */
workspaceRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data
  const includeArchived = q.includeArchived === 'true'

  // One query with LEFT JOIN aggregates for member + flow counts. A workspace
  // with no members / no flows still lists (counts 0). Active-only by default.
  const where = includeArchived ? '' : "WHERE w.status = 'active'"
  let rows: WorkspaceListRow[]
  try {
    const { records } = await runQuery<WorkspaceListRow>(
      `SELECT w.id, w.name, w.glyph, w.description, w.status,
              (SELECT count(*)::text FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
              (SELECT count(*)::text FROM workspace_flows f WHERE f.workspace_id = w.id) AS flow_count,
              w.created_at
         FROM workspaces w
         ${where}
         ORDER BY w.created_at DESC
         LIMIT $1`,
      [q.limit],
    )
    rows = records
  } catch (err) {
    // The workspaces tables may not exist yet on a fresh DB before migrations
    // run; surface a 502 (infrastructure) rather than a 500 leaking the pg
    // error stack (which can carry the connection string).
    log.error('workspace list query failed', { error: String(err) })
    return fail(c, 502, 'workspace list failed')
  }

  return ok(c, {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      glyph: r.glyph ?? r.name.slice(0, 1).toUpperCase(),
      description: r.description,
      status: r.status,
      memberCount: Number(r.member_count ?? 0),
      flowCount: Number(r.flow_count ?? 0),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    })),
  })
})

/**
 * GET /api/v1/workspaces/:id — one project's detail: the workspace row + its
 * members + its linked flows (enriched with live Flowise name/status) + an
 * artifact count rollup. 400 on a malformed id, 404 when no row matches.
 */
workspaceRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid workspace id', { id })
  }

  let wsRow: { id: string; name: string; glyph: string | null; description: string | null; owner_user_id: string | null; status: string; quota: unknown; created_at: Date; updated_at: Date } | null
  try {
    const { records } = await runQuery<{
      id: string
      name: string
      glyph: string | null
      description: string | null
      owner_user_id: string | null
      status: string
      quota: unknown
      created_at: Date
      updated_at: Date
    }>(
      `SELECT id, name, glyph, description, owner_user_id, status, quota, created_at, updated_at
         FROM workspaces WHERE id = $1`,
      [id],
    )
    wsRow = records[0] ?? null
  } catch (err) {
    log.error('workspace detail query failed', { id, error: String(err) })
    return fail(c, 502, 'workspace detail failed')
  }
  if (!wsRow) {
    return fail(c, 404, 'workspace not found', { id })
  }

  let memberRows: WorkspaceMemberRow[]
  let flowRows: WorkspaceFlowRow[]
  let artifactCounts: { reports: number; datasets: number; patches: number }
  try {
    const [m, f, a] = await Promise.all([
      runQuery<WorkspaceMemberRow>(
        `SELECT id, member_id, display_name, initial, role
           FROM workspace_members WHERE workspace_id = $1 ORDER BY created_at ASC`,
        [id],
      ),
      runQuery<WorkspaceFlowRow>(
        `SELECT id, pipeline_id, note FROM workspace_flows WHERE workspace_id = $1 ORDER BY created_at ASC`,
        [id],
      ),
      // Artifact rollup: count runs with an archived `artifact_uri`, classified
      // by the URI's extension. `.csv` → dataset, `.patch` → patch, any other
      // extension → report. Runs without an `artifact_uri` (the common case —
      // only completed+archived runs get one) count as nothing, so the totals
      // reflect real archived artifacts, not every run in the project.
      runQuery<{ kind: string; n: string }>(
        `SELECT kind, count(*)::text AS n FROM (
            SELECT
              CASE
                WHEN artifact_uri ILIKE '%.csv'   THEN 'dataset'
                WHEN artifact_uri ILIKE '%.patch' THEN 'patch'
                WHEN artifact_uri IS NOT NULL     THEN 'report'
              END AS kind
              FROM runs
              WHERE workspace_id = $1::text AND artifact_uri IS NOT NULL
          ) t GROUP BY kind`,
        [id],
      ),
    ])
    memberRows = m.records
    flowRows = f.records
    const byKind: Record<string, number> = { report: 0, dataset: 0, patch: 0 }
    for (const r of a.records) {
      // The CASE yields only report/dataset/patch (artifact_uri is guaranteed
      // non-null by the WHERE); coerce defensively in case of an unexpected kind.
      const k = r.kind in byKind ? r.kind : 'report'
      byKind[k] = (byKind[k] ?? 0) + Number(r.n)
    }
    artifactCounts = { reports: byKind.report, datasets: byKind.dataset, patches: byKind.patch }
  } catch (err) {
    log.error('workspace detail enrich failed', { id, error: String(err) })
    return fail(c, 502, 'workspace detail enrich failed')
  }

  const enriched = await enrichLinkedFlows(flowRows.map((f) => f.pipeline_id))

  return ok(c, {
    workspace: {
      id: wsRow.id,
      name: wsRow.name,
      glyph: wsRow.glyph ?? wsRow.name.slice(0, 1).toUpperCase(),
      description: wsRow.description,
      ownerUserId: wsRow.owner_user_id,
      status: wsRow.status,
      quota: normalizeQuota(wsRow.quota),
      createdAt: wsRow.created_at instanceof Date ? wsRow.created_at.toISOString() : new Date(wsRow.created_at).toISOString(),
      updatedAt: wsRow.updated_at instanceof Date ? wsRow.updated_at.toISOString() : new Date(wsRow.updated_at).toISOString(),
    },
    members: memberRows.map((m) => ({
      id: m.id,
      memberId: m.member_id,
      displayName: m.display_name,
      initial: m.initial,
      role: m.role,
    })),
    flows: flowRows.map((f) => {
      const e = enriched[f.pipeline_id]
      return {
        id: f.id,
        pipelineId: f.pipeline_id,
        note: f.note,
        name: e?.name ?? f.pipeline_id,
        status: e?.status ?? 'unknown',
        updatedAt: e?.updatedAt ?? null,
      }
    }),
    artifacts: artifactCounts,
  })
})

/**
 * GET /api/v1/workspaces/:id/threads — the conversation thread (runs scoped to
 * the workspace), newest-first. Each run is one conversation turn carrying the
 * OTel `run_id`; `runs.input` / `runs.output` are JSONB forwarded verbatim so
 * the view renders the user question + agent answer + produced artifacts. A
 * workspace with no runs returns an empty array (a valid payload, not 404).
 *
 * `limit` caps the page (default 50); the console walks older turns with a
 * `(before, beforeId)` cursor — the oldest run's `created_at` + `id`. The id
 * is the tiebreaker because `runs.created_at` is not unique: a fan-out writes
 * parent + children with `Promise.all`, and several rows can share `NOW()` to
 * the millisecond. `ORDER BY created_at DESC, id DESC` + a compound
 * `(created_at, id) < ($before, $beforeId)` cursor keeps page boundaries stable
 * across same-ms rows so a turn never slips between pages.
 *
 * Only top-level runs (`parent_run_id IS NULL`) surface as thread turns. A
 * fan-out creates 1 parent + N children; the parent's `input` is the batch
 * envelope (`{ flowId, inputs }`) with no `question` field, and the children
 * carry the per-item bodies. Showing all of them would flood the thread with
 * empty turns (see `threadToMessages`'s `readQuestion`), so the thread is the
 * parent/leaf-level view. A single (non-fan-out) run also has
 * `parent_run_id IS NULL` and lists normally.
 */
workspaceRoutes.get('/:id/threads', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid workspace id', { id })
  }
  const threadQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().datetime().optional(),
    /** Tiebreaker id for the `before` cursor (compound `(created_at, id)`). */
    beforeId: z.string().uuid().optional(),
  })
  const parsed = threadQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data
  // `before` without `beforeId` (an older caller) is accepted for back-compat:
  // the compound cursor degrades to a plain `created_at <` bound, which is
  // correct except for the same-ms tiebreak the id fixes.
  if (q.beforeId && !q.before) {
    return fail(c, 400, 'invalid query', { detail: 'beforeId requires before' })
  }

  // runs.workspace_id is TEXT (the migration predates the workspaces table);
  // cast the uuid param to text for the comparison. Newest-first; the compound
  // cursor walks older turns. Fetch limit+1 to detect a next page without a
  // count. `parent_run_id IS NULL` keeps fan-out children out of the thread
  // (see the route doc comment).
  const params: unknown[] = [id]
  const clauses: string[] = ['workspace_id = $1::text', 'parent_run_id IS NULL']
  if (q.before && q.beforeId) {
    params.push(q.before, q.beforeId)
    clauses.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`)
  } else if (q.before) {
    params.push(q.before)
    clauses.push(`created_at < $${params.length}`)
  }
  params.push(q.limit + 1)
  const limitParam = `$${params.length}`

  let rows: ThreadRow[]
  try {
    const { records } = await runQuery<ThreadRow>(
      `SELECT id, identifier, pipeline_id, status, input, output, artifact_uri,
              created_by_user_id, trace_id, created_at, started_at, finished_at
         FROM runs
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limitParam}`,
      params,
    )
    rows = records
  } catch (err) {
    log.error('workspace thread query failed', { id, error: String(err) })
    return fail(c, 502, 'workspace thread failed')
  }

  const hasMore = rows.length > q.limit
  const items = hasMore ? rows.slice(0, q.limit) : rows
  const last = items[items.length - 1]
  const nextBefore = hasMore && last ? last.created_at : null
  const nextBeforeId = hasMore && last ? last.id : null

  return ok(c, {
    items: items.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      pipelineId: r.pipeline_id,
      status: r.status,
      input: r.input,
      output: r.output,
      artifactUri: r.artifact_uri,
      createdByUserId: r.created_by_user_id,
      traceId: r.trace_id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      startedAt: toIso(r.started_at),
      finishedAt: toIso(r.finished_at),
    })),
    nextBefore: nextBefore instanceof Date ? nextBefore.toISOString() : nextBefore,
    nextBeforeId,
  })
})

/**
 * GET /api/v1/workspaces/:id/quota — the monthly quota caps + used counters
 * the meta panel renders. Returns the normalized `WorkspaceQuota` (cost / runs
 * / tokens, each `{ used, cap, unit? }`). The `used` counters are editorial
 * (a later worker rolls `runs` up); the read just forwards the blob.
 */
workspaceRoutes.get('/:id/quota', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid workspace id', { id })
  }
  let row: { quota: unknown } | null
  try {
    const { records } = await runQuery<{ quota: unknown }>(
      `SELECT quota FROM workspaces WHERE id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('workspace quota query failed', { id, error: String(err) })
    return fail(c, 502, 'workspace quota failed')
  }
  if (!row) {
    return fail(c, 404, 'workspace not found', { id })
  }
  return ok(c, { quota: normalizeQuota(row.quota) })
})
