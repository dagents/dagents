import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { DagExecutor, NodeRegistry, allNodes, type FlowData } from '@dagents/workflow'
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

  try {
    const result = await executor.execute(flowData, data.input, {
      chatId,
      runId,
      state: data.state ?? {},
      isLastNode: true,
      startInput,
    })

    c.header('x-run-id', runId)

    if (result.status === 'success') {
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
  } catch (err) {
    log.error('workflow execution failed', { id, error: String(err) })
    return fail(c, 500, 'workflow execution failed')
  }
})
