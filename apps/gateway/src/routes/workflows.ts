import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runQuery, type NodeSpanStatus } from '@dagents/db'
import { makeIncrementalSpanWriter } from '../span-writer.js'
import { createLogger } from '@dagents/shared'
import { exportRunTraceToLangfuse, isLangfuseConfigured } from '@dagents/shared/langfuse'
import { DagExecutor, NodeRegistry, allNodes, CANVAS_NODES, type FlowData, type IExecutedNode } from '@dagents/workflow'
import {
  createDefaultLlmClient,
  createAgentFetcher,
  createBuiltInToolRegistry,
  createHistoryRetriever,
  createFlowExecutor,
  resetProviderCache,
} from './workflow-clients.js'
import { createStaticHumanInputResolver } from './human-input.js'
import { recordAudit } from '../audit.js'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'
import { aggregateExecutedNodesUsage, recordUsageEvent } from '../usage-events.js'

export const workflowsRoutes = new Hono()

const log = createLogger({ svc: 'gateway:workflows' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  flowData: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  flowData: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

interface FlowRow {
  id: string
  name: string
  description: string | null
  flow_data: unknown
  status: string
  created_at: Date
  updated_at: Date
}

function countNodes(flowData: unknown): number {
  if (flowData && typeof flowData === 'object' && 'nodes' in flowData) {
    const nodes = (flowData as { nodes?: unknown }).nodes
    if (Array.isArray(nodes)) {
      return nodes.length
    }
  }
  return 0
}

function normalizeFlowListItem(r: FlowRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    nodeCount: countNodes(r.flow_data),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

function normalizeFlowDetail(r: FlowRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    flowData: r.flow_data,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

workflowsRoutes.get('/', async (c) => {
  const status = c.req.query('status')

  let rows: FlowRow[]
  try {
    let sql = `SELECT id, name, description, flow_data, status, created_at, updated_at
               FROM flows`
    const params: unknown[] = []
    if (status) {
      params.push(status)
      sql += ` WHERE status = $${params.length}`
    }
    sql += ` ORDER BY updated_at DESC`
    const { records } = await runQuery<FlowRow>(sql, params)
    rows = records
  } catch (err) {
    log.error('workflow list query failed', { error: String(err) })
    return fail(c, 502, 'workflow list failed')
  }

  return ok(c, {
    flows: rows.map((r) => normalizeFlowListItem(r)),
  })
})

workflowsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid flow id', { id })
  }

  let row: FlowRow | null
  try {
    const { records } = await runQuery<FlowRow>(
      `SELECT id, name, description, flow_data, status, created_at, updated_at
         FROM flows
         WHERE id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('workflow detail query failed', { id, error: String(err) })
    return fail(c, 502, 'workflow detail failed')
  }
  if (!row) {
    return fail(c, 404, 'flow not found', { id })
  }

  return ok(c, { flow: normalizeFlowDetail(row) })
})

workflowsRoutes.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  let row: FlowRow | null
  try {
    const { records } = await runQuery<FlowRow>(
      `INSERT INTO flows (name, description, flow_data, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, flow_data, status, created_at, updated_at`,
      [
        data.name,
        data.description ?? null,
        JSON.stringify(data.flowData ?? { nodes: [], edges: [] }),
        data.status ?? 'draft',
      ],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('workflow create failed', { error: String(err) })
    return fail(c, 502, 'workflow create failed')
  }
  if (!row) {
    return fail(c, 502, 'workflow create failed')
  }

  await recordAudit(c, {
    action: 'workflow.create',
    target: { type: 'workflow', id: row.id },
    detail: { name: data.name, status: data.status ?? 'draft' },
  })

  return ok(c, { flow: normalizeFlowDetail(row) })
})

workflowsRoutes.put('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid flow id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = updateBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  const sets: string[] = []
  const params: unknown[] = []

  if (data.name !== undefined) {
    params.push(data.name)
    sets.push(`name = $${params.length}`)
  }
  if (data.description !== undefined) {
    params.push(data.description)
    sets.push(`description = $${params.length}`)
  }
  if (data.flowData !== undefined) {
    params.push(JSON.stringify(data.flowData))
    sets.push(`flow_data = $${params.length}`)
  }
  if (data.status !== undefined) {
    params.push(data.status)
    sets.push(`status = $${params.length}`)
  }

  if (sets.length === 0) {
    let existing: FlowRow | null
    try {
      const { records } = await runQuery<FlowRow>(
        `SELECT id, name, description, flow_data, status, created_at, updated_at
           FROM flows
           WHERE id = $1`,
        [id],
      )
      existing = records[0] ?? null
    } catch (err) {
      log.error('workflow detail query failed', { id, error: String(err) })
      return fail(c, 502, 'workflow update failed')
    }
    if (!existing) {
      return fail(c, 404, 'flow not found', { id })
    }
    return ok(c, { flow: normalizeFlowDetail(existing) })
  }

  params.push(id)
  const idParam = `$${params.length}`

  let row: FlowRow | null
  try {
    const { records } = await runQuery<FlowRow>(
      `UPDATE flows
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = ${idParam}
       RETURNING id, name, description, flow_data, status, created_at, updated_at`,
      params,
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('workflow update failed', { id, error: String(err) })
    return fail(c, 502, 'workflow update failed')
  }
  if (!row) {
    return fail(c, 404, 'flow not found', { id })
  }

  const updateDetail: Record<string, unknown> = {}
  if (data.name !== undefined) updateDetail.name = data.name
  if (data.status !== undefined) updateDetail.status = data.status
  if (data.description !== undefined) updateDetail.description = data.description

  await recordAudit(c, {
    action: 'workflow.update',
    target: { type: 'workflow', id },
    detail: updateDetail,
  })

  return ok(c, { flow: normalizeFlowDetail(row) })
})

workflowsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid flow id', { id })
  }

  let deletedId: string | null
  try {
    const { records } = await runQuery<{ id: string }>(
      `DELETE FROM flows WHERE id = $1 RETURNING id`,
      [id],
    )
    deletedId = records[0]?.id ?? null
  } catch (err) {
    log.error('workflow delete failed', { id, error: String(err) })
    return fail(c, 502, 'workflow delete failed')
  }
  if (!deletedId) {
    return fail(c, 404, 'flow not found', { id })
  }

  await recordAudit(c, {
    action: 'workflow.delete',
    target: { type: 'workflow', id: deletedId },
    detail: {},
  })

  return ok(c, { deleted: true, id: deletedId })
})

const runBodySchema = z.object({
  input: z.unknown().optional(),
  chatId: z.string().optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  /** 项目目录 —— CLI 兜底执行的工作目录（画布运行必选语境，chat 路径用会话绑定目录）。 */
  directoryId: z.string().uuid().optional(),
})

const MAX_RUN_ID_LEN = 128

/**
 * Map the executor's IExecutedNode.status or a persisted run_node_spans.status
 * onto the NodeSpanStatus domain used by the scheduler proxy. Kept consistent
 * with the scheduler's own status map.
 */
function toNodeSpanStatus(raw: string): NodeSpanStatus {
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
    case 'STOPPED':
    case 'paused':
      return 'paused'
    default:
      return 'unknown'
  }
}

/**
 * POST /:id/run — Execute a workflow using the internal @dagents/workflow engine.
 *
 * Reads the flow_data from the flows table, builds a NodeRegistry with all
 * available nodes, creates a DagExecutor, and runs the workflow.
 *
 * Returns { success: true, data: { output, executedNodes, state } } on success
 * or { success: false, error: '...' } on failure.
 */
workflowsRoutes.post('/:id/run', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid flow id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = runBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  let row: FlowRow | null
  try {
    const { records } = await runQuery<FlowRow>(
      `SELECT id, name, description, flow_data, status, created_at, updated_at
         FROM flows
         WHERE id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('workflow detail query failed', { id, error: String(err) })
    return fail(c, 502, 'workflow execution failed')
  }
  if (!row) {
    return fail(c, 404, 'flow not found', { id })
  }

  const flowData = row.flow_data as FlowData
  if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
    return fail(c, 400, 'invalid flow data', { id })
  }

  const rawRunId = c.req.header('x-run-id')?.trim()
  const runId = rawRunId && rawRunId.length <= MAX_RUN_ID_LEN ? rawRunId : randomUUID()
  const chatId = data.chatId ?? randomUUID()
  const startInput = typeof data.input === 'string' ? data.input : ''

  const registry = new NodeRegistry()
  registry.registerMany(allNodes())
  const executor = new DagExecutor(registry)

  // Build node-label and node-type lookup maps from the DAG so spans carry the
  // same human-readable metadata the canvas inspector displays.
  const nodeLabelById = new Map<string, string>()
  const nodeTypeById = new Map<string, string>()
  for (const n of flowData.nodes) {
    nodeLabelById.set(n.id, (n.data as { label?: string })?.label ?? n.id)
    nodeTypeById.set(n.id, n.type ?? 'customNode')
  }

  // 解析项目目录 → CLI 工作目录（directoryId 缺省/查不到时 CLI 用网关进程 cwd）
  let runCwd: string | undefined
  if (data.directoryId) {
    try {
      const { records: dirRows } = await runQuery<{ path: string }>(
        `SELECT path FROM directories WHERE id = $1::uuid`,
        [data.directoryId],
      )
      if (dirRows[0]?.path) runCwd = dirRows[0].path
      else log.warn('run directory not found — CLI falls back to gateway cwd', { id, directoryId: data.directoryId })
    } catch (err) {
      log.warn('run directory lookup failed — CLI falls back to gateway cwd', { id, error: String(err) })
    }
  }

  const startedAt = new Date()
  // Reset the LLM provider cache so each run picks up the latest config.
  resetProviderCache()
  // CLI-first：配了 provider 走 HTTP（加速），否则 LLM/Agent 节点全部
  // 跑本地 CLI —— 工作流与聊天一样零配置可用。
  const llmClient = createDefaultLlmClient('claude', { cwd: runCwd })
  const agentFetcher = createAgentFetcher()
  const toolRegistry = createBuiltInToolRegistry()
  const historyRetriever = createHistoryRetriever(chatId)
  // Non-interactive run: HumanInput answers must be pre-supplied via the
  // request's state.humanInputs map (keyed by prompt); a missing answer
  // fails the node with guidance to use the chat path instead.
  const humanInputsRaw = (data.state ?? {}).humanInputs
  const humanInputs: Record<string, string> =
    typeof humanInputsRaw === 'object' && humanInputsRaw !== null && !Array.isArray(humanInputsRaw)
      ? (humanInputsRaw as Record<string, string>)
      : {}
  const humanInputResolver = createStaticHumanInputResolver(humanInputs)
  // ExecuteFlow nodes run subflows on this run's clients; their executed
  // nodes are collected and persisted as spans alongside the parent's.
  const subflowNodes: IExecutedNode[] = []
  const flowExecutor = createFlowExecutor({
    chatId,
    runId,
    llmClient,
    agentFetcher,
    toolRegistry,
    historyRetriever,
    humanInputResolver,
    onExecutedNodes: (nodes) => subflowNodes.push(...nodes),
  })

  // 闭包（runAndPersist）内赋值、闭包外（同步响应）读取：
  // `!` 明确赋值断言 + runStatus 用 string（TS 无法跨闭包收窄）
  let result!: { status: string; finalOutput: unknown; executedNodes: IExecutedNode[]; state: Record<string, unknown>; error?: string }
  let finishedAt = new Date()
  let durationMs = 0
  let runStatus: string = 'running'
  // Cancellation handle (spec D4): workflow runs register by runId —
  // POST /workflows/runs/:runId/cancel aborts the engine signal.
  const abort = new AbortController()
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const execHandle: ExecutionHandle = {
    chatId,
    runId,
    kind: 'workflow-run',
    startedAt: startedAt.getTime(),
    abort: (reason?: string) => abort.abort(new Error(reason ?? 'cancelled by caller')),
    done,
  }
  executionRegistry.register(execHandle)
  // 节点生命周期 → 增量写 run_node_spans（画布实时进度的数据源）。
  // 共享实现见 span-writer.ts；事后批量落库跳过已增量写过的节点。
  const spanWriter = makeIncrementalSpanWriter({ runId, flowId: id, nodeLabelById, nodeTypeById, log })

  /** 执行 + 全部落库（runs 终态行 / usage / 批量 spans / Langfuse）。
   *  同步路径 await 它；异步路径（?async=1）void 它 —— 客户端靠轮询
   *  node-spans + runStatus 获得终态，不再受代理层超时影响。 */
  const runAndPersist = async (): Promise<void> => {
  try {
    result = await executor.execute(flowData, data.input, {
      chatId,
      runId,
      state: data.state ?? {},
      isLastNode: true,
      startInput,
      signal: abort.signal,
      llmClient,
      agentFetcher,
      // Built-in tools (http_request / datetime_now) form the base registry;
      // Tool nodes in the graph register themselves into the per-run overlay
      // as they execute, so downstream Agent nodes can call them.
      toolRegistry,
      historyRetriever,
      humanInputResolver,
      flowExecutor,
      onNodeStart: spanWriter.onNodeStart,
      onNodeEnd: spanWriter.onNodeEnd,
    })
  } catch (err) {
    log.error('workflow execution failed', { id, error: String(err) })
    // 异常也置 failed 终态 —— 否则异步轮询方会永远看到 running
    result = { status: 'failed', finalOutput: null, executedNodes: [], state: {}, error: String(err) }
  } finally {
    resolveDone()
    executionRegistry.unregister(execHandle)
  }
  // Subflow executions surface in the same trace/span set as the parent run.
  result.executedNodes = [...result.executedNodes, ...subflowNodes]
  finishedAt = new Date()
  durationMs = Math.round(finishedAt.getTime() - startedAt.getTime())
  runStatus =
    result.status === 'success' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed'

  // AD-3（方案 D b 路径）：run 级用量聚合 —— sum 各节点 tokens，cost 只在
  // 所有 token 节点都有价格时成立（引擎目前 cost 恒 null → priced=false，
  // 「未计价 token」在账单页单列）。三个终态（completed/failed/cancelled）
  // 都入账；没有 token 的 run 由 recordUsageEvent 自行跳过。
  const usageRollup = aggregateExecutedNodesUsage(result.executedNodes)

  try {
    // Persist a single `runs` row so the run id is authoritative in the DB
    // (scheduler proxy paths resolve a run id → spans from this table too).
    // `cost` 消灭死列：写入聚合成本。列是 NOT NULL，无价格时写 0 ——
    // 「未计价」的诚实标记在 usage_events.priced，runs.cost 只是去规格化
    // 汇总（账单页只读 usage_events）。
    await runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms, cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         output = EXCLUDED.output,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms,
         cost = EXCLUDED.cost`,
      [
        runId,
        runId,
        id,
        runStatus,
        JSON.stringify(data.input ?? null),
        JSON.stringify(result.finalOutput ?? null),
        startedAt,
        finishedAt,
        durationMs,
        usageRollup.cost ?? 0,
      ],
    )
  } catch (err) {
    log.warn('persist runs row failed, spans still written below', { id, runId, error: String(err) })
  }

  // 账单真相源（AD-3）：workflow run 终态各写一条 usage_events。
  await recordUsageEvent({
    source: 'workflow_run',
    chatId,
    runId,
    flowId: id,
    usage: usageRollup.usage,
    cost: usageRollup.cost,
  })

  // Persist one run_node_spans row per executed node so the canvas /
  // inspector can paint node status + read duration. Nodes the executor never
  // reached (e.g. early-return / skipped branch) are not written — the canvas
  // leaves them `idle`.
  try {
    const spanPlaceholders: string[] = []
    const spanValues: unknown[] = []
    let i = 1
    for (const en of result.executedNodes) {
      // 增量路径已实时写过（画布进度轮询的数据源），只补子流程节点等遗漏项
      if (spanWriter.writtenNodes.has(en.nodeId)) continue
      const started = en.startedAt ? new Date(en.startedAt) : startedAt
      const finished = en.endedAt ? new Date(en.endedAt) : finishedAt
      const durMs = Math.max(0, finished.getTime() - started.getTime())
      const status: NodeSpanStatus = en.status === 'success'
        ? 'done'
        : en.status === 'failed'
        ? 'failed'
        : en.status === 'running'
        ? 'running'
        : en.status === 'cancelled'
        ? 'paused'
        : 'unknown'
      // 14 columns: run_id, flow_id, node_id, node_label, node_type, status,
      // started_at, finished_at, duration_ms, tokens, cost, error, input, output
      spanPlaceholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`)
      spanValues.push(
        runId,
        id,
        en.nodeId,
        nodeLabelById.get(en.nodeId) ?? null,
        nodeTypeById.get(en.nodeId) ?? null,
        status,
        started,
        finished,
        durMs,
        en.tokens ? JSON.stringify(en.tokens) : null,
        en.cost ?? null,
        en.error ?? null,
        Object.keys(en.input ?? {}).length > 0 ? JSON.stringify(en.input) : null,
        Object.keys(en.output ?? {}).length > 0 ? JSON.stringify(en.output) : null,
      )
    }
    if (spanPlaceholders.length > 0) {
      await runQuery(
        `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, tokens, cost, error, input, output)
         VALUES ${spanPlaceholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        spanValues,
      )
    }
  } catch (err) {
    log.warn('persist run_node_spans failed', { id, runId, error: String(err) })
  }

  // Export the run's node trace to Langfuse (v2 ingestion API — see
  // @dagents/shared/langfuse). Off unless LANGFUSE_* env keys are set; a
  // failed export never fails the run. On success the trace id (== runId)
  // is stamped onto the spans for end-to-end correlation.
  if (isLangfuseConfigured()) {
    const langfuse = await exportRunTraceToLangfuse({
      runId,
      flowId: id,
      flowName: row.name,
      chatId,
      status: runStatus as 'completed' | 'failed' | 'cancelled' | 'running',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      input: data.input ?? null,
      output: result.finalOutput ?? null,
      nodes: result.executedNodes,
    })
    if (langfuse.exported && langfuse.traceId) {
      try {
        await runQuery(
          `UPDATE run_node_spans SET trace_id = $1 WHERE run_id = $2 AND trace_id IS NULL`,
          [langfuse.traceId, runId],
        )
      } catch (err) {
        log.warn('stamp trace_id on spans failed', { id, runId, error: String(err) })
      }
    } else if (langfuse.error) {
      log.warn('langfuse export failed', { id, runId, error: langfuse.error })
    }
  }

  } // ← runAndPersist 闭包结束

  // ── 异步模式：立即返回，后台执行（画布/长流程用） ──
  if (c.req.query('async') === '1') {
    // 先落一行 running（轮询终态判断依据 + 运行历史即时可见）；
    // 结束时 runAndPersist 里的 ON CONFLICT 会更新为终态。
    try {
      await runQuery(
        `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, duration_ms, cost)
         VALUES ($1::uuid, $2::text, $3::uuid, 'running', $4, NULL, $5, NULL, 0)
         ON CONFLICT (id) DO NOTHING`,
        [runId, runId, id, JSON.stringify(data.input ?? null), startedAt],
      )
    } catch (err) {
      log.warn('async runs row init failed', { id, runId, error: String(err) })
    }
    void runAndPersist().catch((err) => {
      log.error('async run crashed', { id, runId, error: String(err) })
    })
    c.header('x-run-id', runId)
    return ok(c, { runId, async: true })
  }

  await runAndPersist()

  c.header('x-run-id', runId)

  if (runStatus === 'completed') {
    return ok(c, {
      output: result.finalOutput,
      executedNodes: result.executedNodes,
      state: result.state,
    })
  }
  if (runStatus === 'cancelled') {
    // User-initiated cancel is a distinct terminal — not a 500-style failure.
    return ok(c, {
      output: null,
      executedNodes: result.executedNodes,
      state: result.state,
      status: 'cancelled',
    })
  }
  return fail(c, 500, result.error ?? 'workflow execution failed', {
    executedNodes: result.executedNodes,
    state: result.state,
  })
})

interface NodeSpanRow {
  node_id: string
  node_label: string | null
  node_type: string | null
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
 * GET /runs/:runId/node-spans — Gateway-owned read path for a run's node trace.
 *
 * The scheduler proxy (M6.4) is authoritative only for fan-out runs that the
 * scheduler produced. For single-run workflows executed directly through the
 * gateway (`POST /:id/run`), we write `run_node_spans` from the executor's
 * executedNodes. This route surfaces them with the same envelope shape the
 * console's node-spans module consumes, so the browser can render node status
 * / duration / labels for gateway-run flows too.
 *
 * 404 for an unknown runId → empty spans (the console degrades to `idle` for
 * every node).
 */
workflowsRoutes.get('/runs/:runId/node-spans', async (c) => {
  const runId = c.req.param('runId')
  if (runId.length > MAX_RUN_ID_LEN) {
    return fail(c, 400, 'invalid run id', { runId })
  }

  let rows: NodeSpanRow[] = []
  let runStatus: string | null = null
  let runDurationMs: number | null = null
  try {
    const { records } = await runQuery<NodeSpanRow>(
      `SELECT node_id, node_label, node_type, status, started_at, finished_at, duration_ms, tokens, cost, error, trace_id, input, output
         FROM run_node_spans
         WHERE run_id = $1
         ORDER BY COALESCE(started_at, created_at) ASC`,
      [runId],
    )
    rows = records
  } catch (err) {
    log.error('node-spans query failed', { runId, error: String(err) })
    return fail(c, 502, 'node-spans query failed')
  }
  // 附带 runs 行的状态/耗时 —— 画布旁观（canvas?run=）据此判断终态。
  // 没有 runs 行（老数据 / 尚未落库）时为 null，旁观端回退到启发式判断。
  try {
    const { records: runRows } = await runQuery<{ status: string; duration_ms: number | null }>(
      `SELECT status, duration_ms FROM runs WHERE id = $1`,
      [runId],
    )
    runStatus = runRows[0]?.status ?? null
    runDurationMs = runRows[0]?.duration_ms ?? null
  } catch {
    // runs 查询失败不影响 spans 返回
  }

  const spans = rows.map((r) => {
    const startedAt = r.started_at instanceof Date
      ? r.started_at.toISOString()
      : r.started_at != null ? new Date(r.started_at).toISOString() : null
    const finishedAt = r.finished_at instanceof Date
      ? r.finished_at.toISOString()
      : r.finished_at != null ? new Date(r.finished_at).toISOString() : null
    const cost = r.cost == null ? null : Number(r.cost)
    return {
      nodeId: r.node_id,
      nodeLabel: r.node_label,
      nodeType: r.node_type,
      status: toNodeSpanStatus(r.status),
      startedAt,
      finishedAt,
      durationMs: r.duration_ms,
      tokens: r.tokens ?? null,
      cost: Number.isFinite(cost) ? cost : null,
      error: r.error,
      traceId: r.trace_id,
      input: r.input ?? null,
      output: r.output ?? null,
    }
  })

  return ok(c, { runId, runStatus, runDurationMs, spans })
})

/**
 * GET /canvas/nodes — Expose canvas node metadata (descriptions, inputs,
 * categories) so the frontend can render node type info without importing
 * the workflow package directly.
 */
workflowsRoutes.get('/canvas/nodes', (c) => {
  return ok(c, { nodes: CANVAS_NODES })
})
