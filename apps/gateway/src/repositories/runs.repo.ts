/**
 * runs.repo.ts — `runs` + `run_node_spans` 两张表的数据访问层。
 *
 * runs：执行轨迹主档（一次工作流 / chat 流式 / @daemon 直发各一行；
 * pipeline_id 指向 flow，chat_id 关联会话，agent_daemon_calls 记 dispatch
 * 归属）。run_node_spans：逐节点执行 span（画布旁观 / 结果面板 / 终端视图
 * 的数据源；span-writer.ts 是它的增量写侧服务，本层提供批量补写与读路径）。
 *
 * 另含两个取消级联用的只读查找（runs.chat_id 名下活跃 run、run 名下未终态
 * dispatch 任务）—— dispatch 族保持自治，这里只服务 chat/run 取消链路。
 */
import { runQuery, type NodeSpanStatus } from '@dagents/db'

export interface NodeSpanRow {
  node_id: string
  node_label: string | null
  node_type: string | null
  /** per-node 执行实例序号（R8，design-recover §1.3 标注列——不参与键）。 */
  ordinal: number
  status: string
  started_at: Date | string | null
  finished_at: Date | string | null
  duration_ms: number | null
  tokens: unknown
  cost: string | number | null
  error: string | null
  trace_id: string | null
  input: unknown
  output: unknown
}

/**
 * Map the executor's IExecutedNode.status or a persisted run_node_spans.status
 * onto the NodeSpanStatus domain used by the scheduler proxy. Kept consistent
 * with the scheduler's own status map.
 */
export function toNodeSpanStatus(raw: string): NodeSpanStatus {
  switch (raw) {
    case 'success':
    case 'done':
    case 'completed':
      return 'done'
    case 'fail':
    case 'failed':
    case 'error':
      return 'failed'
    case 'running':
    case 'INPROGRESS':
      return 'running'
    case 'cancel':
    case 'cancelled':
    case 'paused':
      return 'paused'
    // 2026-10-07 可恢复性地基（随写方批次改齐，design-recover §1.3）：
    // cached = 种子命中跳过执行的节点终态（引擎 cached 钩子回放）；
    // stopped = boot sweep 对悬空 running span 的收敛。DB CHECK 词表由
    // 1720000106200 一次放宽到位（三方共同前置）。
    case 'cached':
      return 'cached'
    case 'stopped':
      return 'stopped'
    // 2026-10-07 工程决策 9d（design-sharp §2.4）：声明型超限拒绝的节点
    // 终态——可重试黄警档（run 走 partial_success），与 failed 视觉区分。
    case 'rejected':
      return 'rejected'
    case 'STOPPED':
      return 'paused'
    default:
      return 'unknown'
  }
}

/** 画布旁观读路径：一个 run 的全部节点 span（按开始时间升序）。 */
export async function getRunNodeSpans(runId: string): Promise<NodeSpanRow[]> {
  const { records } = await runQuery<NodeSpanRow>(
    `SELECT node_id, node_label, node_type, ordinal, status, started_at, finished_at, duration_ms, tokens, cost, error, trace_id, input, output
       FROM run_node_spans
       WHERE run_id = $1
       ORDER BY COALESCE(started_at, created_at) ASC`,
    [runId],
  )
  return records
}

/** runs 行的状态/耗时（旁观端终态判断；无行 → null，端侧回退启发式）。
 *  2026-09-19 P0：附带 directory_id —— node-spans 响应的目录锚数据源。
 *  2026-10-07 R10：附带 source —— 结果面板「⚡ 试运行」标记条数据源。
 *  2026-10-07 R3（design-recover §3.5(c)）：附带 stop_reason —— console
 *  判「已中断（可恢复）」vs「已停止」的中止来源（interrupted/user）。 */
export async function getRunStatusAndDuration(
  runId: string,
): Promise<
  | {
      status: string
      duration_ms: number | null
      directory_id: string | null
      source: string | null
      stop_reason: string | null
      /** 谱系锚（R2.3 双口径）：非空 = resume/暖缓存 run——node-spans 端点
       *  据此计算谱系继承累计 token（前驱 usage_events SUM）。 */
      resumed_from_run_id: string | null
    }
  | null
> {
  const { records } = await runQuery<{
    status: string
    duration_ms: number | null
    directory_id: string | null
    source: string | null
    stop_reason: string | null
    resumed_from_run_id: string | null
  }>(
    `SELECT status, duration_ms, directory_id, source, stop_reason, resumed_from_run_id
       FROM runs WHERE id = $1`,
    [runId],
  )
  return records[0] ?? null
}

/** run 级失败原因（node-spans 响应的 runError 数据源）：执行器整体失败
 *  （如拓扑成环、启动即挂）不产生任何节点 span，错误只落在 checkpoint
 *  快照的 failedAt —— 不带出来的话，零 span 失败在前端无从解释。 */
export async function getRunError(runId: string): Promise<string | null> {
  const { records } = await runQuery<{ error: string | null }>(
    `SELECT snapshot->'failedAt'->>'error' AS error FROM run_checkpoints WHERE run_id = $1`,
    [runId],
  )
  return records[0]?.error ?? null
}

/** 会话执行记录（chat 详情右栏；runs.chat_id 是 TEXT，入参转 text 比较）。 */
export async function listRunsForChat(chatId: string): Promise<
  Array<{
    id: string
    status: string
    created_at: Date
    finished_at: Date | null
    duration_ms: number | null
    pipeline_id: string | null
    flow_name: string | null
  }>
> {
  const { records } = await runQuery<{
    id: string
    status: string
    created_at: Date
    finished_at: Date | null
    duration_ms: number | null
    pipeline_id: string | null
    flow_name: string | null
  }>(
    `SELECT r.id, r.status, r.created_at, r.finished_at, r.duration_ms,
            r.pipeline_id, f.name AS flow_name
       FROM runs r
       LEFT JOIN flows f ON f.id::text = r.pipeline_id::text
      WHERE r.chat_id = $1::text
      ORDER BY r.created_at DESC
      LIMIT 50`,
    [chatId],
  )
  return records
}

export interface RunHistoryRow {
  id: string
  flow_id: string | null
  flow_name: string | null
  status: string
  started_at: Date | null
  finished_at: Date | null
  duration_ms: number | null
  input: unknown
  chat_id: string | null
  created_at: Date
  first_error: string | null
  /** 2026-09-19 P0 数据链：运行的项目目录锚（终端入口数据源）。 */
  directory_id: string | null
  /** 2026-10-04 谱系：本 run 从哪个 run 断点续跑/应答回流而来（无 = 根运行）。 */
  resumed_from_run_id: string | null
  /** 2026-10-07 R10：触发来源（canvas/chat/trial/resume/answer；NULL = 迁移前旧行）。 */
  source: string | null
  /** 2026-10-07 R3（design-recover §3.3）：中止/失败来源（stopped/failed 行）。 */
  stop_reason: string | null
}

/**
 * 跨 Flow 运行历史（Workflow-First 运行页）：可选状态/flow 过滤 + 失败摘要。
 *
 * 2026-10-07 R10 试运行隔离（design-sharp §1.1）：`source` 缺省（不传）时
 * 追加 `IS DISTINCT FROM 'trial' OR IS NULL`——正式历史视图零试运行混入
 * （FlowRunsPanel 拉本端点零改动即隔离，AC-R10-3 第一隔离面）；显式传
 * `{ includeTrial: true }` 或 `source: 'trial'` 才看得到试运行行。
 */
export async function listRunsHistory(opts: {
  status?: string
  flowId?: string
  limit: number
  /** 显式正向过滤某个来源（'trial' 试运行历史显式查询用）。 */
  source?: string
  /** 缺省 false = 排除试运行行；true = 不过滤（管理/调试视图）。 */
  includeTrial?: boolean
}): Promise<RunHistoryRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.status) {
    params.push(opts.status)
    where.push(`r.status = $${params.length}`)
  }
  if (opts.flowId) {
    params.push(opts.flowId)
    where.push(`r.pipeline_id = $${params.length}`)
  }
  if (opts.source) {
    params.push(opts.source)
    where.push(`r.source = $${params.length}`)
  } else if (!opts.includeTrial) {
    where.push(`(r.source IS DISTINCT FROM 'trial' OR r.source IS NULL)`)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  params.push(opts.limit)
  const limitIdx = params.length
  const { records } = await runQuery<RunHistoryRow>(
    `SELECT r.id, r.pipeline_id AS flow_id, f.name AS flow_name,
            r.status, r.started_at, r.finished_at, r.duration_ms,
            r.input, r.chat_id, r.created_at, r.directory_id,
            r.resumed_from_run_id, r.source, r.stop_reason,
            (SELECT left(s.error, 160) FROM run_node_spans s
              WHERE s.run_id = r.id AND s.status = 'failed' AND s.error IS NOT NULL
              ORDER BY s.started_at ASC LIMIT 1) AS first_error
       FROM runs r
       LEFT JOIN flows f ON f.id::text = r.pipeline_id
       ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT $${limitIdx}`,
    params,
  )
  return records
}

export interface RunFlowSummaryRow {
  flow_id: string
  latest_status: string | null
  latest_run_id: string | null
  latest_at: Date | null
  run_count: string | number
}

/** 批量每-flow 运行摘要（DISTINCT ON 取最新一条 + 次数聚合）。 */
export async function summarizeRunsByFlow(flowIds: string[]): Promise<RunFlowSummaryRow[]> {
  const { records } = await runQuery<RunFlowSummaryRow>(
    `SELECT r.pipeline_id AS flow_id,
            latest.status AS latest_status,
            latest.id AS latest_run_id,
            latest.created_at AS latest_at,
            COUNT(r.id)::text AS run_count
       FROM runs r
       LEFT JOIN LATERAL (
         SELECT id, status, created_at FROM runs s
          WHERE s.pipeline_id = r.pipeline_id
          ORDER BY s.created_at DESC LIMIT 1
       ) latest ON true
      WHERE r.pipeline_id = ANY($1::text[])
      GROUP BY r.pipeline_id, latest.id, latest.status, latest.created_at`,
    [flowIds],
  )
  return records
}

/** 画布/chat 直跑的终态落库（upsert：异步模式先落的 running 行被更新为终态）。 */
export async function persistWorkflowRunRow(input: {
  runId: string
  flowId: string
  status: string
  inputJson: string
  /** SQL NULL（无 output）或 JSON 字符串 —— 调用方决定，原样入库。 */
  outputJson: string | null
  startedAt: Date
  finishedAt: Date
  durationMs: number
  cost: number
  /** 2026-09-18：chat 触发的画布运行也落关联（应答回流 join 依赖）。 */
  chatId?: string | null
  /** 2026-09-19 P0 数据链：运行的项目目录锚（终端入口「一扇门」的数据源）。 */
  directoryId?: string | null
  /** 2026-11-10 目标环：本轮 run 归属的 goal（轮次谱系/预算 rollup 依赖）。 */
  goalId?: string | null
  /** 断点续跑谱系：新 run 行指向原 run（COALESCE 保已存值）。 */
  resumedFromRunId?: string | null
  /** 2026-10-07 R10：触发来源（canvas/trial/resume/answer…）；COALESCE 保已存值。 */
  source?: string | null
  /** 2026-10-07 R3（design-recover §3.3(c)）：中止/失败来源（stop_reason 列，
   *  五值词表见 RunStopReason）——stopped/failed 终态行携带，其余传 null。 */
  stopReason?: string | null
  /** 2026-10-07 R8（design-recover §3.6(b)）：persona 冻结快照 JSON（含可选
   *  sessions 会话映射）——终态行落库（running 先行行不落，冷启动无快照）。 */
  frozenAgentsJson?: string | null
  /** 2026-10-07 R8（§3.6(c)）：run 级模型快照 JSON（{ [nodeId]: resolvedModel }）。 */
  modelsJson?: string | null
}): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms, cost, chat_id, resumed_from_run_id, directory_id, source, stop_reason, frozen_agents, models, goal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13::uuid, $14, $15, $16::jsonb, $17::jsonb, $18::uuid)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       output = EXCLUDED.output,
       finished_at = EXCLUDED.finished_at,
       duration_ms = EXCLUDED.duration_ms,
       cost = EXCLUDED.cost,
       chat_id = COALESCE(EXCLUDED.chat_id, runs.chat_id),
       resumed_from_run_id = COALESCE(EXCLUDED.resumed_from_run_id, runs.resumed_from_run_id),
       directory_id = COALESCE(EXCLUDED.directory_id, runs.directory_id),
       source = COALESCE(EXCLUDED.source, runs.source),
       stop_reason = EXCLUDED.stop_reason,
       frozen_agents = COALESCE(EXCLUDED.frozen_agents, runs.frozen_agents),
       models = COALESCE(EXCLUDED.models, runs.models),
       goal_id = COALESCE(EXCLUDED.goal_id, runs.goal_id)`,
    [
      input.runId,
      input.runId,
      input.flowId,
      input.status,
      input.inputJson,
      input.outputJson,
      input.startedAt,
      input.finishedAt,
      input.durationMs,
      input.cost,
      input.chatId ?? null,
      input.resumedFromRunId ?? null,
      input.directoryId ?? null,
      input.source ?? null,
      input.stopReason ?? null,
      input.frozenAgentsJson ?? null,
      input.modelsJson ?? null,
      input.goalId ?? null,
    ],
  )
}

/** 异步模式的先行行：立即落 running（轮询终态依据 + 运行历史即时可见）。 */
export async function initAsyncWorkflowRunRow(input: {
  runId: string
  flowId: string
  inputJson: string
  startedAt: Date
  directoryId?: string | null
  /** 2026-10-07 R10：触发来源（画布直跑 'canvas' / 试运行 'trial'）。 */
  source?: string | null
  /** 2026-11-10 目标环：本轮 run 归属的 goal（轮次谱系/预算 rollup 依赖）。 */
  goalId?: string | null
}): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, duration_ms, cost, directory_id, source, goal_id)
     VALUES ($1::uuid, $2::text, $3::uuid, 'running', $4, NULL, $5, NULL, 0, $6::uuid, $7, $8::uuid)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.runId,
      input.runId,
      input.flowId,
      input.inputJson,
      input.startedAt,
      input.directoryId ?? null,
      input.source ?? null,
      input.goalId ?? null,
    ],
  )
}

/** chat 流式路径的终态落库（best-effort；含 chat_id 关联）。 */
export async function upsertChatWorkflowRunRow(input: {
  runId: string
  flowId: string
  chatId: string
  status: string
  inputJson: string
  outputJson: string
  startedAtIso: string
  durationMs: number
  /** 2026-09-19 P0：chat 起源运行的目录锚继承自 chats.directory_id。 */
  directoryId?: string | null
  /** 2026-10-07 R10：触发来源（chat 流式路径恒 'chat'）。 */
  source?: string | null
  /** 2026-10-07 R3（design-recover §3.3(c)）：chat 流式路径 cancelled→stopped
   *  写新的中止来源（user/superseded，classifyAbortReason 判定）。 */
  stopReason?: string | null
}): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, chat_id, status, input, output, started_at, finished_at, duration_ms, cost, directory_id, source, stop_reason)
     VALUES ($1::uuid, $2::text, $3::uuid, $4::text, $5, $6, $7, $8, NOW(), $9, 0, $10::uuid, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       output = EXCLUDED.output,
       finished_at = EXCLUDED.finished_at,
       duration_ms = EXCLUDED.duration_ms,
       directory_id = COALESCE(EXCLUDED.directory_id, runs.directory_id),
       source = COALESCE(EXCLUDED.source, runs.source),
       stop_reason = EXCLUDED.stop_reason`,
    [
      input.runId,
      input.runId,
      input.flowId,
      input.chatId,
      input.status,
      input.inputJson,
      input.outputJson,
      input.startedAtIso,
      input.durationMs,
      input.directoryId ?? null,
      input.source ?? 'chat',
      input.stopReason ?? null,
    ],
  )
}

/** @daemon 直发任务的真实 runs 行（path='direct'：取消级联/清扫/usage 的锚）。 */
export async function insertDirectDaemonRunRow(input: {
  runId: string
  identifier: string
  agentDaemonId: string
  inputJson: string
  chatId: string
}): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, path, chat_id, started_at)
     VALUES ($1::uuid, $2, $3, 'running', $4, 'direct', $5::uuid, NOW())`,
    [input.runId, input.identifier, input.agentDaemonId, input.inputJson, input.chatId],
  )
}

/** 事后批量补写节点 span（增量路径已实时写过的节点由调用方过滤）。 */
export interface NodeSpanInsertRow {
  run_id: string
  flow_id: string
  node_id: string
  node_label: string | null
  node_type: string | null
  status: NodeSpanStatus
  started_at: Date
  finished_at: Date
  duration_ms: number
  tokens: string | null
  cost: number | null
  error: string | null
  input: string | null
  output: string | null
}

export async function insertNodeSpansBatch(rows: NodeSpanInsertRow[]): Promise<void> {
  if (rows.length === 0) return
  const spanPlaceholders: string[] = []
  const spanValues: unknown[] = []
  let i = 1
  for (const row of rows) {
    // 14 columns: run_id, flow_id, node_id, node_label, node_type, status,
    // started_at, finished_at, duration_ms, tokens, cost, error, input, output
    spanPlaceholders.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`,
    )
    spanValues.push(
      row.run_id,
      row.flow_id,
      row.node_id,
      row.node_label,
      row.node_type,
      row.status,
      row.started_at,
      row.finished_at,
      row.duration_ms,
      row.tokens,
      row.cost,
      row.error,
      row.input,
      row.output,
    )
  }
  await runQuery(
    `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, tokens, cost, error, input, output)
     VALUES ${spanPlaceholders.join(', ')}
     ON CONFLICT DO NOTHING`,
    spanValues,
  )
}

/** Langfuse 导出成功后把 trace id 盖到尚未标记的 span 上。 */
export async function stampRunSpansTraceId(traceId: string, runId: string): Promise<void> {
  await runQuery(`UPDATE run_node_spans SET trace_id = $1 WHERE run_id = $2 AND trace_id IS NULL`, [
    traceId,
    runId,
  ])
}

/** agent 详情的 runs 关联（usage @> 包含查询，与 dispatch 详情路由同契约）。 */
export async function listRunsTouchingAgentDaemon(
  adId: string,
): Promise<Array<{ id: string; identifier: string; status: string; cost: string }>> {
  const { records } = await runQuery<{
    id: string
    identifier: string
    status: string
    cost: string
  }>(
    `SELECT id, identifier, status, cost::text AS cost
       FROM runs
      WHERE agent_daemon_calls @> $1::jsonb
      ORDER BY created_at DESC
      LIMIT 20`,
    [JSON.stringify([{ agentDaemonId: adId }])],
  )
  return records
}

/** chat 取消级联：该会话名下的活跃 runs（@daemon 路径落了真实 runs 行）。 */
export async function listActiveRunIdsForChat(chatId: string): Promise<string[]> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM runs WHERE chat_id = $1::uuid AND status IN ('running', 'pending')`,
    [chatId],
  )
  return records.map((r) => r.id)
}

/**
 * run 取消级联：run 名下未终态的 dispatch 任务 id。（查的是 dispatch_tasks
 * 表，但只服务取消链路 —— dispatch 族的写路径仍在 routes/dispatch/service.ts。）
 */
export async function listDispatchTaskIdsForRunCascade(runId: string): Promise<string[]> {
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM dispatch_tasks WHERE run_id = $1 AND status NOT IN ('completed', 'failed')`,
    [runId],
  )
  return records.map((r) => r.id)
}
