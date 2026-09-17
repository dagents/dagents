/**
 * agents.repo.ts — `agents` 表（平台 Agent 主档）的数据访问层。
 *
 * agents：v0.3 域模型的编辑器字段 1:1 落列（instructions/skills/visibility/
 * concurrency/model/runtime/owner_id/status/availability/activity/summary/
 * input_schema/output_schema + library_meta 人格库溯源）。目录读路径 LEFT
 * JOIN workspace_members（负责人名）、agent_daemons + daemons（运行时注册）
 * 与 dispatch_tasks LATERAL（最新任务）拼出设计稿的完整单 agent 对象。
 * agent_daemons 表自身的按名/按 kind 查找在 agent-daemons.repo.ts。
 */
import { runQuery, withTransaction } from '@dagents/db'

/**
 * snake_case row shape from pg for an `agents` row joined to its owner member.
 *
 * `roles` / `skills` / `activity` are JSONB arrays (parsed by the pg driver).
 * `owner_display` is the resolved human name from `workspace_members`; NULL
 * when the owner has no member row, in which case the route falls back to the
 * raw `owner_id` text so the design's `负责人` prop-row always renders a value.
 */
export interface AgentRow {
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
export function toAgentDto(row: AgentRow): Record<string, unknown> {
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

/** 目录列表（设计稿全字段 + 运行时 join），created_at 倒序。 */
export async function listAgentsWithRuntime(limit: number): Promise<AgentRow[]> {
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
    [limit],
  )
  return records
}

/** 单 agent 详情行（与列表同形状的 join）。 */
export async function getAgentDetailRow(id: string): Promise<AgentRow | null> {
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
  return records[0] ?? null
}

export interface AgentTaskHistoryItem {
  id: string
  run_id: string
  status: string
  usage: unknown
  duration_ms: number | null
  created_at: string
  finished_at: string | null
}

/** 活动页任务历史（sparkline + cost rollup），created_at 倒序、已转 ISO。 */
export async function listAgentRecentTasks(adId: string, limit: number): Promise<AgentTaskHistoryItem[]> {
  const { records } = await runQuery<{
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
    [adId, limit],
  )
  return records.map((t) => ({
    id: t.id,
    run_id: t.run_id,
    status: t.status,
    usage: t.usage,
    duration_ms: t.duration_ms,
    created_at: toIso(t.created_at) ?? '',
    finished_at: toIso(t.finished_at),
  }))
}

/** 轻量存在性检查（logs 路由区分「无此 agent」与「无日志」）。 */
export async function agentExists(id: string): Promise<boolean> {
  const { records } = await runQuery<{ id: string }>(`SELECT id FROM agents WHERE id = $1`, [id])
  return !!records[0]
}

/** agent 任务日志原始事件（dispatch_task_events ⋈ dispatch_tasks），倒序。 */
export async function listAgentLogEvents(
  id: string,
  limit: number,
): Promise<Array<{ kind: string; seq: number; payload: unknown; created_at: Date }>> {
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
    [id, limit],
  )
  return records
}

/**
 * Map a dispatch_task_event payload to a drawer log line — same shape/contract
 * as the dispatch route's `eventToLogLine` so the console logs tab is
 * unchanged. `payload` is an `AgentEvent` union; collapsed to `{ts,level,msg}`.
 */
export function eventToLogLine(row: { kind: string; seq: number; payload: unknown; created_at: Date }): {
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

/** PATCH 白名单列（顺序即 SET 构建顺序）。skills 单独走 jsonb cast。 */
export interface UpdateAgentPatch {
  visibility?: unknown
  name?: unknown
  instructions?: unknown
  model?: unknown
  summary?: unknown
  status?: unknown
  availability?: unknown
  /** 已通过路由层校验的字符串数组；此处去重 + stringify。 */
  skills?: string[]
}

/** 动态 PATCH：只写提供的列。返回 'missing' 表示无此行（路由转 404）。 */
export async function updateAgentFields(
  id: string,
  patch: UpdateAgentPatch,
): Promise<'updated' | 'missing'> {
  const allowed: Array<[keyof UpdateAgentPatch, string]> = [
    ['visibility', 'visibility'],
    ['name', 'name'],
    ['instructions', 'instructions'],
    ['model', 'model'],
    ['summary', 'summary'],
    ['status', 'status'],
    ['availability', 'availability'],
  ]

  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, col] of allowed) {
    if (patch[key] !== undefined) {
      params.push(patch[key])
      sets.push(`${col} = $${params.length}`)
    }
  }

  // skills 是 jsonb 字符串数组（本地技能注册表里的 kebab-case 名称）。
  // 单独处理：需要去重 + ::jsonb cast。
  if (patch.skills !== undefined) {
    params.push(JSON.stringify([...new Set(patch.skills)]))
    sets.push(`skills = $${params.length}::jsonb`)
  }

  sets.push(`updated_at = NOW()`)
  params.push(id)

  const { records } = await runQuery<{ id: string }>(
    `UPDATE agents SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params,
  )
  return records[0] ? 'updated' : 'missing'
}

/**
 * 删除 agent + agent_daemons 桥接行（单事务：避免留幽灵桥接行）。
 * 返回 false = 无此行（404）。
 */
export async function deleteAgentCascade(id: string): Promise<boolean> {
  const deleted = await withTransaction(async (tx) => {
    const { records } = await tx<{ id: string }>(
      `DELETE FROM agents WHERE id = $1 RETURNING id`,
      [id],
    )
    if (!records[0]) return null
    await tx(`DELETE FROM agent_daemons WHERE id = $1`, [id])
    return records[0]
  })
  return !!deleted
}

/** POST / 的完整创建输入（路由层负责 zod 校验 + executablePath/daemon 检查）。 */
export interface CreateAgentInput {
  id: string
  workspaceId: string
  name: string
  kind: string
  ownerId: string
  daemonId?: string | null
  instructions: string
  skills: string[]
  roles: string[]
  model: string
  runtime: string
  visibility: string
  concurrency: number
  status: string
  availability: string
  summary: string
  inputSchema: string
  outputSchema: string
  executablePath?: string | null
}

/**
 * 创建平台 agent（编辑器行 + 可选 agent_daemons 桥接行，共享 id）。
 * 桥接行两种形态：daemonId → 完整注册（daemon 托管）；executablePath 无
 * daemonId → inline-executor agent（gateway 直接 spawn CLI，availability
 * 置 online）。整体单事务 —— 桥接失败即整体回滚，不留半注册常态。
 */
export async function insertAgentWithBridge(input: CreateAgentInput): Promise<void> {
  // Bridge row: register the agent with a daemon under the same id so the
  // runtime read path (agent_daemons join) lights up immediately.
  const needsBridge = Boolean(input.daemonId || input.executablePath)
  const capabilityDescriptor = {
    name: input.name,
    summary: input.summary,
    tags: input.roles,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
  }
  // For inline-executor agents (no daemonId but has executablePath), mark
  // availability as 'online' since the gateway can spawn the CLI directly —
  // no daemon process needed.  Without this, the agent shows as 'offline'
  // even though it is immediately usable via inline execution.
  const finalAvailability = (!input.daemonId && input.executablePath)
    ? 'online'
    : input.availability

  await withTransaction(async (tx) => {
    await tx(
      `INSERT INTO agents (id, workspace_id, name, kind, roles, instructions, skills,
                           visibility, concurrency, model, runtime, owner_id,
                           status, availability, activity, summary, input_schema, output_schema,
                           daemon_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb,
               $8, $9, $10, $11, $12,
               $13, $14, '[]'::jsonb, $15, $16, $17,
               $18)`,
      [
        input.id,
        input.workspaceId,
        input.name,
        input.kind,
        JSON.stringify(input.roles),
        input.instructions,
        JSON.stringify(input.skills),
        input.visibility,
        input.concurrency,
        input.model,
        input.runtime,
        input.ownerId,
        input.status,
        finalAvailability,
        input.summary,
        input.inputSchema,
        input.outputSchema,
        input.daemonId ?? null,
      ],
    )
    if (needsBridge) {
      await tx(
        `INSERT INTO agent_daemons (id, name, kind, daemon_id, capability_descriptor,
                                    executable_path, visibility, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.id,
          input.name,
          input.kind,
          input.daemonId ?? null,
          JSON.stringify(capabilityDescriptor),
          input.executablePath ?? null,
          input.visibility,
          input.workspaceId,
        ],
      )
    }
  })
}

/** agent-invoke 的首选查找：agents 表的 kind。 */
export async function getAgentKind(id: string): Promise<string | null> {
  const { records } = await runQuery<{ kind: string }>(
    `SELECT kind FROM agents WHERE id = $1::uuid`,
    [id],
  )
  return records[0]?.kind ?? null
}

/** @agent 命令按名解析（agents 表优先）。 */
export async function findAgentIdByName(name: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agents WHERE name = $1 LIMIT 1`,
    [name],
  )
  return records[0]?.id ?? null
}

/** auto 路由兜底 ①：可本机执行的 CLI kind 中最早创建的一个。 */
export async function findFirstAgentByKinds(kinds: string[]): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agents WHERE kind = ANY($1::text[]) ORDER BY created_at ASC LIMIT 1`,
    [kinds],
  )
  return records[0]?.id ?? null
}

/** auto 路由兜底 ③：agents 表任意（执行时报友好错误）。 */
export async function findFirstAgentAny(): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM agents ORDER BY created_at ASC LIMIT 1`,
  )
  return records[0]?.id ?? null
}

/** 人格库 drift 清单：所有带 library_meta 溯源的已启用行。 */
export async function listLibraryAgentRows(): Promise<
  Array<{ id: string; name: string; instructions: string | null; library_meta: unknown }>
> {
  const { records } = await runQuery<
    { id: string; name: string; instructions: string | null; library_meta: unknown }
  >(
    `SELECT id, name, instructions, library_meta FROM agents
      WHERE library_meta IS NOT NULL AND library_meta->>'id' IS NOT NULL
      ORDER BY name`,
  )
  return records
}

/** reimport：按最新库文件覆盖 instructions + 溯源（id/引用不变）。 */
export async function updateAgentReimport(
  rowId: string,
  input: { instructions: string; summary: string; libraryMetaJson: string },
): Promise<void> {
  await runQuery(
    `UPDATE agents
        SET instructions = $1, summary = $2, library_meta = $3::jsonb, updated_at = NOW()
      WHERE id = $4::uuid`,
    [input.instructions, input.summary, input.libraryMetaJson, rowId],
  )
}

/** 模板抽取的 agentId → 人格名映射（只认 library 溯源的 agent，设计 D2）。 */
export async function findAgentNamesByLibrary(
  agentIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  const { records } = await runQuery<{ id: string; name: string }>(
    `SELECT id, name FROM agents
      WHERE id = ANY($1::uuid[]) AND library_meta->>'id' IS NOT NULL`,
    [agentIds],
  )
  return records
}
