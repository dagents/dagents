import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@dagents/shared'
import { findAgentReferences } from '@dagents/workflow'
import { checkExecutablePath } from '../lib/executable-path.js'
import {
  listAgentsWithRuntime,
  getAgentDetailRow,
  listAgentRecentTasks,
  agentExists,
  listAgentLogEvents,
  eventToLogLine,
  updateAgentFields,
  deleteAgentCascade,
  insertAgentWithBridge,
  toAgentDto,
  type AgentRow,
} from '../repositories/agents.repo.js'
import { daemonExists } from '../repositories/agent-daemons.repo.js'
import { listFlowsContainingText } from '../repositories/workflows.repo.js'
import { listRunsTouchingAgentDaemon } from '../repositories/runs.repo.js'
import { ok, fail } from '../lib/http.js'
import { UUID_RE } from '../lib/http.js'

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
 * All reads are parameterised raw SQL via the repositories layer, returning
 * the standard `{ success, data }` envelope. No filters are pushed into SQL —
 * the catalogue is small for MVP so kind/status/role filtering happens
 * client-side, keeping the SQL static (no dynamic WHERE building) and the
 * routes trivial to audit. ⚠️ The list route does NOT yet scope rows by
 * workspace/membership (it returns the full catalogue) — membership scoping
 * lands with RBAC (follow-up, not this task).
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
    rows = await listAgentsWithRuntime(LIST_FETCH)
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
    row = await getAgentDetailRow(id)
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
  let tasks: Awaited<ReturnType<typeof listAgentRecentTasks>> = []
  if (row.ad_id) {
    try {
      tasks = await listAgentRecentTasks(row.ad_id, DETAIL_TASK_LIMIT)
    } catch (err) {
      log.error('agent detail tasks query failed', { id, error: String(err) })
    }
  }

  // Best-effort runs lookup (same shape/contract as the dispatch detail route).
  let runs: { id: string; identifier: string; status: string; cost: string }[] = []
  if (row.ad_id) {
    try {
      runs = await listRunsTouchingAgentDaemon(row.ad_id)
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

  // Scan flows for Platform Agent nodes referencing this agent. A cheap SQL
  // LIKE prefilter narrows the scan to flows whose JSONB actually contains the
  // id（引用必含 id 字面量）—— 全量拉表在 flows 增长后是 O(全库) 的
  // JSONB 反序列化（2026-09-17 评审修复）。精确判定仍在应用层做
  // （findAgentReferences 兼容两种存储形态，比镜像一个 jsonb_path_query
  // 好审计）。
  let flowRows: Awaited<ReturnType<typeof listFlowsContainingText>>
  try {
    flowRows = await listFlowsContainingText(id)
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

  // No references — delete agent + bridge row atomically（此前两条独立
  // DELETE，第二条失败会留 agent_daemons 幽灵行，2026-09-17 评审修复）。
  try {
    const deleted = await deleteAgentCascade(id)
    if (!deleted) {
      return fail(c, 404, 'agent not found', { id })
    }
  } catch (err) {
    log.error('agent delete failed', { id, error: String(err) })
    return fail(c, 502, 'agent delete failed')
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

  // Whitelist updatable columns; 只收集 body 里出现的键（undefined 视同缺省）。
  const patch: Parameters<typeof updateAgentFields>[1] = {}
  if ('visibility' in body) patch.visibility = body.visibility
  if ('name' in body) patch.name = body.name
  if ('instructions' in body) patch.instructions = body.instructions
  if ('model' in body) patch.model = body.model
  if ('summary' in body) patch.summary = body.summary
  if ('status' in body) patch.status = body.status
  if ('availability' in body) patch.availability = body.availability

  // skills 是 jsonb 字符串数组（本地技能注册表里的 kebab-case 名称）。
  // 单独处理：需要校验元素类型。
  if ('skills' in body) {
    const skills = body.skills
    if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string' && s.length > 0)) {
      return fail(c, 400, 'skills must be a non-empty array of strings')
    }
    patch.skills = skills as string[]
  }

  const hasUpdates = Object.keys(patch).length > 0
  if (!hasUpdates) {
    return fail(c, 400, 'no updatable fields provided')
  }

  try {
    const outcome = await updateAgentFields(id, patch)
    if (outcome === 'missing') {
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
    if (!(await agentExists(id))) {
      return fail(c, 404, 'agent not found', { id })
    }
  } catch (err) {
    log.error('agent logs: agent lookup failed', { id, error: String(err) })
    return fail(c, 502, 'agent logs failed')
  }

  let logs: Array<{ ts: string; level: string; msg: string }>
  try {
    const rows = await listAgentLogEvents(id, LOG_LIMIT)
    logs = rows.map(eventToLogLine)
  } catch (err) {
    log.error('agent logs query failed', { id, error: String(err) })
    return fail(c, 502, 'agent logs failed')
  }

  return ok(c, { logs })
})

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

  // Spawn-surface guard: executablePath ends up as the literal exec path the
  // inline executor / agent-invoke spawn. In default no-auth mode accepting
  // any string here was "register any binary as an agent, execute on next
  // trigger". Absolute + existing regular file only (2026-09-17 review).
  if (parsed.executablePath) {
    const check = checkExecutablePath(parsed.executablePath)
    if (!check.ok) {
      return fail(c, 400, 'invalid executablePath', { detail: check.reason })
    }
    parsed.executablePath = check.path
  }

  // When a daemonId is supplied, verify the daemon exists before inserting
  // (the agent_daemons FK would 500 otherwise; we want a clean 404).
  if (parsed.daemonId) {
    try {
      if (!(await daemonExists(parsed.daemonId))) {
        return fail(c, 404, 'daemon not found', { daemonId: parsed.daemonId })
      }
    } catch (err) {
      log.error('agent create: daemon lookup failed', { error: String(err) })
      return fail(c, 502, 'agent create failed')
    }
  }

  const id = randomUUID()

  // 编辑器行 + 可选桥接行（共享 id）。两条路径创建桥接行：
  //   1. daemonId supplied → full registration (daemon-managed agent)
  //   2. executablePath supplied, no daemonId → inline-executor agent
  //      (gateway spawns the CLI directly, no daemon process needed).
  //      We create the agent_daemons row WITHOUT a daemon_id so the
  //      inline-executor can find the agent by id + read executable_path.
  //
  // 原子化（2026-09-17 评审修复）：此前三段 best-effort 独立写，桥接失败
  // 留下「编辑器有行、运行时没行」的半注册常态 —— 现在整体一个事务，
  // 桥接失败即整体回滚并如实 502（Platform Agent 场景重试即可）。
  try {
    await insertAgentWithBridge({
      id,
      workspaceId: parsed.workspaceId,
      name: parsed.name,
      kind: parsed.kind,
      ownerId: parsed.ownerId,
      daemonId: parsed.daemonId ?? null,
      instructions: parsed.instructions,
      skills: parsed.skills,
      roles: parsed.roles,
      model: parsed.model,
      runtime: parsed.runtime,
      visibility: parsed.visibility,
      concurrency: parsed.concurrency,
      status: parsed.status,
      availability: parsed.availability,
      summary: parsed.summary,
      inputSchema: parsed.inputSchema,
      outputSchema: parsed.outputSchema,
      executablePath: parsed.executablePath ?? null,
    })
  } catch (err) {
    log.error('agent create failed (rolled back)', { id, error: String(err) })
    return fail(c, 502, 'agent create failed', { detail: 'insert rolled back — see gateway logs' })
  }

  log.info('agent created', { id, daemonId: parsed.daemonId ?? null })
  return ok(c, { id })
})
