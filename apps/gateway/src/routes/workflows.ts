import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runQuery, type NodeSpanStatus } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { DagExecutor, NodeRegistry, allNodes, CANVAS_NODES, type FlowData, type IExecutedNode } from '@dagents/workflow'
import { createLlmClient, createAgentFetcher, resetProviderCache } from './workflow-clients.js'
import { recordAudit } from '../audit.js'

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

  const startedAt = new Date()
  // Reset the LLM provider cache so each run picks up the latest config.
  resetProviderCache()
  const llmClient = createLlmClient()
  const agentFetcher = createAgentFetcher()

  let result: { status: string; finalOutput: unknown; executedNodes: IExecutedNode[]; state: Record<string, unknown>; error?: string }
  try {
    result = await executor.execute(flowData, data.input, {
      chatId,
      runId,
      state: data.state ?? {},
      isLastNode: true,
      startInput,
      llmClient,
      agentFetcher,
      // Tool registry for the Platform Agent / Agent tool-calling loop. Empty
      // today — tools are wired through the context contract so nodes can
      // consume them as soon as a tool source (e.g. Tool nodes in the graph)
      // is registered here.
      toolRegistry: {},
    })
  } catch (err) {
    log.error('workflow execution failed', { id, error: String(err) })
    return fail(c, 500, 'workflow execution failed')
  }
  const finishedAt = new Date()
  const durationMs = Math.round(finishedAt.getTime() - startedAt.getTime())
  const runStatus: 'running' | 'completed' | 'failed' =
    result.status === 'success' ? 'completed' : 'failed'

  try {
    // Persist a single `runs` row so the run id is authoritative in the DB
    // (scheduler proxy paths resolve a run id → spans from this table too).
    await runQuery(
      `INSERT INTO runs (id, identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         output = EXCLUDED.output,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms`,
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
      ],
    )
  } catch (err) {
    log.warn('persist runs row failed, spans still written below', { id, runId, error: String(err) })
  }

  // Persist one run_node_spans row per executed node so the canvas /
  // inspector can paint node status + read duration. Nodes the executor never
  // reached (e.g. early-return / skipped branch) are not written — the canvas
  // leaves them `idle`.
  try {
    const spanPlaceholders: string[] = []
    const spanValues: unknown[] = []
    let i = 1
    for (const en of result.executedNodes) {
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

  c.header('x-run-id', runId)

  if (runStatus === 'completed') {
    return ok(c, {
      output: result.finalOutput,
      executedNodes: result.executedNodes,
      state: result.state,
    })
  } else {
    return fail(c, 500, result.error ?? 'workflow execution failed', {
      executedNodes: result.executedNodes,
      state: result.state,
    })
  }
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

  return ok(c, { runId, spans })
})

/**
 * GET /canvas/nodes — Expose canvas node metadata (descriptions, inputs,
 * categories) so the frontend can render node type info without importing
 * the workflow package directly.
 */
workflowsRoutes.get('/canvas/nodes', (c) => {
  return ok(c, { nodes: CANVAS_NODES })
})
