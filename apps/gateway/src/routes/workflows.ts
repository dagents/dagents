import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { NodeSpanStatus } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { exportRunTraceToLangfuse, isLangfuseConfigured } from '@dagents/shared/langfuse'
import { CANVAS_NODES, type FlowData, type IExecutedNode, type ExecutionResult } from '@dagents/workflow'
import { sendToRunNode, runHasLiveSinks } from './workflow-clients.js'
import { assembleWorkflowEngine, toRunStatus } from './workflow-engine-service.js'
import { makePersistentHumanInputResolver, makeCheckpointHook, computeTopoHash } from './resume-execution.js'
import { getCheckpoint, upsertCheckpoint, updateCheckpointStatus } from '../repositories/run-checkpoints.repo.js'
import { recordAudit } from '../audit.js'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'
import { aggregateExecutedNodesUsage, recordUsageEvent } from '../usage-events.js'
import {
  listFlows,
  getFlowById,
  createFlow,
  updateFlowFields,
  updateFlowLayout,
  deleteFlow,
  normalizeFlowListItem,
  normalizeFlowDetail,
  type FlowRow,
} from '../repositories/workflows.repo.js'
import { getDirectoryPath } from '../repositories/directories.repo.js'
import {
  getRunNodeSpans,
  getRunStatusAndDuration,
  persistWorkflowRunRow,
  initAsyncWorkflowRunRow,
  insertNodeSpansBatch,
  stampRunSpansTraceId,
  toNodeSpanStatus,
} from '../repositories/runs.repo.js'
import { ok, fail, UUID_RE } from '../lib/http.js'

export const workflowsRoutes = new Hono()

const log = createLogger({ svc: 'gateway:workflows' })


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

workflowsRoutes.get('/', async (c) => {
  const status = c.req.query('status')

  let rows: FlowRow[]
  try {
    rows = await listFlows(status)
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
    row = await getFlowById(id)
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
    row = await createFlow({
      name: data.name,
      description: data.description ?? null,
      flowDataJson: JSON.stringify(data.flowData ?? { nodes: [], edges: [] }),
      status: data.status ?? 'draft',
    })
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

  const hasUpdates =
    data.name !== undefined ||
    data.description !== undefined ||
    data.flowData !== undefined ||
    data.status !== undefined

  if (!hasUpdates) {
    let existing: FlowRow | null
    try {
      existing = await getFlowById(id)
    } catch (err) {
      log.error('workflow detail query failed', { id, error: String(err) })
      return fail(c, 502, 'workflow update failed')
    }
    if (!existing) {
      return fail(c, 404, 'flow not found', { id })
    }
    return ok(c, { flow: normalizeFlowDetail(existing) })
  }

  let row: FlowRow | null
  try {
    row = await updateFlowFields(id, {
      name: data.name,
      description: data.description,
      flowDataJson: data.flowData !== undefined ? JSON.stringify(data.flowData) : undefined,
      status: data.status,
    })
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

/**
 * 布局自动保存（2026-09-06 画布优化）：拖拽停/视口停后 debounce 静默
 * PATCH —— 只 merge `flow_data` 里已有节点的 position 与顶层 viewport，
 * 不触碰节点配置（尊重草稿自由：配置编辑仍走显式保存管线）。
 * 画布刷新不再回退到旧布局。
 */
const layoutBodySchema = z.object({
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number() })
    .optional(),
})

workflowsRoutes.put('/:id/layout', async (c) => {
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
  const parsed = layoutBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const { positions, viewport } = parsed.data
  if (!positions && !viewport) {
    return fail(c, 400, 'empty layout body')
  }

  let row: FlowRow | null
  try {
    row = await getFlowById(id)
  } catch (err) {
    log.error('workflow layout read failed', { id, error: String(err) })
    return fail(c, 502, 'workflow layout update failed')
  }
  if (!row) {
    return fail(c, 404, 'flow not found', { id })
  }

  // 服务端 merge：只更新已存在节点的坐标（未知 id 静默忽略 —— 客户端
  // 可能拿着删除前的快照），viewport 整体替换；其余字段一字不动。
  let flowData: Record<string, unknown>
  try {
    flowData = (row.flow_data ?? {}) as Record<string, unknown>
  } catch {
    flowData = {}
  }
  let appliedPositions = 0
  if (positions && Array.isArray(flowData.nodes)) {
    flowData.nodes = (flowData.nodes as Array<Record<string, unknown>>).map((n) => {
      const p = n.id != null ? positions[String(n.id)] : undefined
      if (!p) return n
      appliedPositions += 1
      return { ...n, position: { x: Math.round(p.x), y: Math.round(p.y) } }
    })
  }
  if (viewport) {
    flowData.viewport = {
      x: Math.round(viewport.x),
      y: Math.round(viewport.y),
      zoom: viewport.zoom,
    }
  }

  try {
    await updateFlowLayout(id, JSON.stringify(flowData))
  } catch (err) {
    log.error('workflow layout update failed', { id, error: String(err) })
    return fail(c, 502, 'workflow layout update failed')
  }

  // 布局是无语义的视觉调整，不进审计日志（会淹没真正的 workflow.update）。
  return ok(c, { appliedPositions, viewport: viewport ?? null })
})

workflowsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid flow id', { id })
  }

  let deletedId: string | null
  try {
    deletedId = await deleteFlow(id)
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
    row = await getFlowById(id)
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

  // x-run-id 必须是 UUID：runs.id 是 UUID 列，任何非 UUID 值都会让 INSERT
  // 静默失败（被 catch 吞成 warn）——运行历史/取消级联/chat 关联全部失效
  // 且调用方不知情（2026-09-17 评审修复）。
  const rawRunId = c.req.header('x-run-id')?.trim()
  const runId = rawRunId && UUID_RE.test(rawRunId) ? rawRunId : randomUUID()
  if (rawRunId && !UUID_RE.test(rawRunId)) {
    log.warn('ignoring non-UUID x-run-id header (runs.id is a uuid column)', { id, rawRunId })
  }
  const chatId = data.chatId ?? randomUUID()
  const startInput = typeof data.input === 'string' ? data.input : ''

  // 解析项目目录 → CLI 工作目录（directoryId 缺省/查不到时 CLI 用网关进程 cwd）
  let runCwd: string | undefined
  if (data.directoryId) {
    try {
      const path = await getDirectoryPath(data.directoryId)
      if (path) runCwd = path
      else log.warn('run directory not found — CLI falls back to gateway cwd', { id, directoryId: data.directoryId })
    } catch (err) {
      log.warn('run directory lookup failed — CLI falls back to gateway cwd', { id, error: String(err) })
    }
  }

  const startedAt = new Date()
  // 引擎装配单一来源（与 chat 流式 / @flow 路径共用；此前三处复制漂移）
  const { executor, spanWriter, nodeLabelById, nodeTypeById, baseOptions } = assembleWorkflowEngine({
    flowData,
    runId,
    flowId: id,
    cwd: runCwd,
    logger: log,
  })
  // Non-interactive run: HumanInput answers must be pre-supplied via the
  // request's state.humanInputs map (keyed by prompt); a missing answer
  // fails the node with guidance to use the chat path instead.
  const humanInputsRaw = (data.state ?? {}).humanInputs
  const humanInputs: Record<string, string> =
    typeof humanInputsRaw === 'object' && humanInputsRaw !== null && !Array.isArray(humanInputsRaw)
      ? (humanInputsRaw as Record<string, string>)
      : {}
  // 持久 HumanInput（P2）：预供答案命中即答；无则挂起（awaiting）而非失败
  const humanInputResolver = makePersistentHumanInputResolver(humanInputs)
  // 断点续跑：波次/迭代粒度快照（失败后可从断点续跑）
  const checkpointHook = makeCheckpointHook({ checkpointRunId: runId, flowId: id, flowData })

  // 闭包（runAndPersist）内赋值、闭包外（同步响应）读取：
  // `!` 明确赋值断言 + runStatus 用 string（TS 无法跨闭包收窄）
  type RunResultAwaiting = { nodeId: string; prompt: string; inputType: string; options: unknown[] }
  type RunResultShape = Omit<ExecutionResult, 'awaiting'> & { awaiting?: RunResultAwaiting }
  let result!: RunResultShape
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
    // 运行中插话（2026-09-08 可操作终端）：abort 的姊妹控制动词 —— 经
    // workflow-clients 的汇点表路由到目标节点的活 CLI 会话。
    sendToNode: (nodeId: string, text: string) => sendToRunNode(runId, nodeId, text),
    done,
  }
  executionRegistry.register(execHandle)

  /** 执行 + 全部落库（runs 终态行 / usage / 批量 spans / Langfuse）。
   *  同步路径 await 它；异步路径（?async=1）void 它 —— 客户端靠轮询
   *  node-spans + runStatus 获得终态，不再受代理层超时影响。 */
  const runAndPersist = async (): Promise<void> => {
  try {
    result = await executor.execute(flowData, data.input, {
      ...baseOptions,
      chatId,
      runId,
      state: data.state ?? {},
      isLastNode: true,
      startInput,
      signal: abort.signal,
      humanInputResolver,
      onCheckpoint: checkpointHook,
    })
  } catch (err) {
    log.error('workflow execution failed', { id, error: String(err) })
    // 异常也置 failed 终态 —— 否则异步轮询方会永远看到 running
    result = { status: 'failed', finalOutput: null, executedNodes: [], state: {}, error: String(err) }
  } finally {
    resolveDone()
    executionRegistry.unregister(execHandle)
  }
  // 持久挂起（P2 §6.3）：不判失败 —— checkpoint awaiting + runs awaiting_input
  if (result.status === 'awaiting' && result.awaiting) {
    // 经钩子串行链写 awaiting —— 直连 upsert 会被在途波次快照后发覆盖
    const deadlineAt = new Date(Date.now() + Number(process.env.HUMAN_INPUT_TIMEOUT_MS ?? 300_000)).toISOString()
    checkpointHook.suspend({ ...result.awaiting, deadlineAt })
    runStatus = 'awaiting_input'
  }

  // 终态 checkpoint 收敛（经钩子串行链：快照 failedAt 与 status 合并一次写，
  // 杜绝迟到波次快照覆盖终态字段的竞态）
  if (result.status !== 'awaiting') {
    checkpointHook.terminalize(
      result.status === 'success' ? 'terminal' : 'resumable',
      result.status !== 'success' && result.error
        ? { nodeId: (result.executedNodes.find((n) => n.status === 'failed')?.nodeId) ?? '', error: result.error }
        : undefined,
    )
  }

  finishedAt = new Date()
  durationMs = Math.round(finishedAt.getTime() - startedAt.getTime())
  runStatus = result.status === 'awaiting' ? 'awaiting_input' : toRunStatus(result.status)

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
    await persistWorkflowRunRow({
      runId,
      flowId: id,
      status: runStatus,
      inputJson: JSON.stringify(data.input ?? null),
      outputJson: JSON.stringify(result.finalOutput ?? null),
      startedAt,
      finishedAt,
      durationMs,
      cost: usageRollup.cost ?? 0,
      chatId: chatId || null,
    })
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
    const spanRows: Parameters<typeof insertNodeSpansBatch>[0] = []
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
      spanRows.push({
        run_id: runId,
        flow_id: id,
        node_id: en.nodeId,
        node_label: nodeLabelById.get(en.nodeId) ?? null,
        node_type: nodeTypeById.get(en.nodeId) ?? null,
        status,
        started_at: started,
        finished_at: finished,
        duration_ms: durMs,
        tokens: en.tokens ? JSON.stringify(en.tokens) : null,
        cost: en.cost ?? null,
        error: en.error ?? null,
        input: Object.keys(en.input ?? {}).length > 0 ? JSON.stringify(en.input) : null,
        output: Object.keys(en.output ?? {}).length > 0 ? JSON.stringify(en.output) : null,
      })
    }
    await insertNodeSpansBatch(spanRows)
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
        await stampRunSpansTraceId(langfuse.traceId, runId)
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
      await initAsyncWorkflowRunRow({
        runId,
        flowId: id,
        inputJson: JSON.stringify(data.input ?? null),
        startedAt,
      })
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

  if (runStatus === 'awaiting_input' && result.awaiting) {
    // 持久挂起（P2）：非失败 —— 返回挂起载荷（应答端点/聊天回复续跑）
    return ok(c, {
      status: 'awaiting_input',
      awaiting: result.awaiting,
      executedNodes: result.executedNodes,
    })
  }
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

  let rows: Awaited<ReturnType<typeof getRunNodeSpans>> = []
  let runStatus: string | null = null
  let runDurationMs: number | null = null
  try {
    rows = await getRunNodeSpans(runId)
  } catch (err) {
    log.error('node-spans query failed', { runId, error: String(err) })
    return fail(c, 502, 'node-spans query failed')
  }
  // 附带 runs 行的状态/耗时 —— 画布旁观（canvas?run=）据此判断终态。
  // 没有 runs 行（老数据 / 尚未落库）时为 null，旁观端回退到启发式判断。
  try {
    const runRow = await getRunStatusAndDuration(runId)
    runStatus = runRow?.status ?? null
    runDurationMs = runRow?.duration_ms ?? null
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

  // 附带插话能力位（2026-09-08 可操作终端）：该 run 当前是否有活着的 CLI
  // 会话汇点 —— console 据此渲染 stdin 行的禁用态（HTTP provider 运行 /
  // 无活会话 → 不可插话，如实禁用不假装）。
  const inputSupported = runHasLiveSinks(runId)

  return ok(c, { runId, runStatus, runDurationMs, inputSupported, spans })
})

/**
 * GET /canvas/nodes — Expose canvas node metadata (descriptions, inputs,
 * categories) so the frontend can render node type info without importing
 * the workflow package directly.
 */
workflowsRoutes.get('/canvas/nodes', (c) => {
  return ok(c, { nodes: CANVAS_NODES })
})
