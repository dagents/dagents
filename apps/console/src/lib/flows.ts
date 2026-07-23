/**
 * Flow browse domain types + Flowise → console transforms (P1.10.T5).
 *
 * The console's AgentFlows browse page is read-only: it lists flows, renders a
 * flow's DAG (the React Flow nodes/edges Flowise already stores as `flowData`),
 * colors each node by its run status, and shows per-node run metrics
 * (duration / budget / tokens / cost / logs) in an inspector.
 *
 * The data comes from two Flowise endpoints, proxied read-only by the gateway
 * (see `apps/gateway/src/app.ts` `proxyFlowiseRead`):
 *
 *   GET /api/v1/chatflows?type=AGENTFLOW   → flow list (rows incl. `flowData`)
 *   GET /api/v1/chatflows/:id              → one flow (incl. `flowData` DAG JSON)
 *   GET /api/v1/executions?agentflowId=…   → recent executions for that flow
 *
 * `flowData` is a JSON string; parsed it is `{ nodes: IReactFlowNode[], edges:
 * IReactFlowEdge[], viewport }` — exactly the shape React Flow consumes. We
 * surface node position/label and the edge source/target; the rest of the
 * Flowise node payload (params, credentials, handle bounds) stays opaque.
 *
 * ## Run state → node status coloring
 *
 * Flowise records an execution's per-node trace in `Execution.executionData`:
 * an array of `IAgentflowExecutedData` (`{ nodeLabel, nodeId, data, status }`).
 * Each entry carries an `ExecutionState` (`INPROGRESS | FINISHED | ERROR |
 * TERMINATED | TIMEOUT | STOPPED`). We map that onto the node-card status the
 * design colors (`running | done | failed | queued | idle | paused`), taking
 * the most recent entry per nodeId so a re-run doesn't paint a node with a
 * stale earlier status.
 *
 * ## Why pure transforms (no fetch here)
 *
 * Keeping the mapping as pure functions means the shape contract is unit-
 * testable without a gateway, and the Next API routes (`/api/flows/…`) own the
 * fetch + zod boundary. The browser fetches the console's own routes, which in
 * turn fetch the gateway — so the Flowise API key never leaves the server and
 * the Flowise shapes never reach the client bundle.
 */

import { z } from 'zod'

// ─── Flowise source shapes (only the fields we read) ───────────────────────

/** One entry in an execution's per-node trace (Flowise `IAgentflowExecutedData`). */
const flowiseExecutedNodeSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string().optional(),
  status: z.string().optional(),
  data: z.unknown().optional(),
  previousNodeIds: z.array(z.string()).optional(),
})
type FlowiseExecutedNode = z.infer<typeof flowiseExecutedNodeSchema>

/** A Flowise `Execution` row (only the fields the browse page reads). */
export const flowiseExecutionSchema = z.object({
  id: z.string(),
  agentflowId: z.string(),
  sessionId: z.string(),
  state: z.string(),
  // executionData is a JSON string in the DB; the service layer JSON.parses it
  // before returning. It may also arrive already-parsed (object) or null.
  executionData: z.union([z.string(), z.array(flowiseExecutedNodeSchema), z.null()]).optional(),
  action: z.string().nullable().optional(),
  createdDate: z.union([z.string(), z.date()]),
  updatedDate: z.union([z.string(), z.date()]).optional(),
  stoppedDate: z.union([z.string(), z.date(), z.null()]).optional(),
})
export type FlowiseExecution = z.infer<typeof flowiseExecutionSchema>

/** A React Flow node as Flowise stores it in `flowData`. */
const flowDataNodeSchema = z.object({
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  type: z.string().optional(),
  data: z
    .object({
      label: z.string().optional(),
      // Flowise nodes carry an `id` inside `data` too (the node instance id);
      // it can differ from the React Flow `id`. We read `label` for display and
      // ignore the rest of the params/credentials payload.
    })
    .passthrough()
    .optional(),
})

/** A React Flow edge as Flowise stores it in `flowData`. */
const flowDataEdgeSchema = z.object({
  id: z.string().optional(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  type: z.string().optional(),
  label: z.string().optional(),
  data: z.object({ label: z.string().optional() }).optional(),
})

/** Parsed `flowData` — React Flow's `{ nodes, edges, viewport }`. */
export const flowDataSchema = z.object({
  nodes: z.array(flowDataNodeSchema).default([]),
  edges: z.array(flowDataEdgeSchema).default([]),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number() })
    .optional(),
})
export type FlowData = z.infer<typeof flowDataSchema>

/** A Flowise `ChatFlow` row (only the fields the browse page reads). */
export const flowiseChatflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  deployed: z.boolean().nullable().optional(),
  category: z.string().nullable().optional(),
  flowData: z.string().optional(),
  createdDate: z.union([z.string(), z.date()]),
  updatedDate: z.union([z.string(), z.date()]),
})
export type FlowiseChatflow = z.infer<typeof flowiseChatflowSchema>

// ─── Console domain types ───────────────────────────────────────────────────

/** Node-card status the design colors (design/js/flows-data.js STATUS set). */
export type NodeRunStatus = 'running' | 'done' | 'failed' | 'queued' | 'idle' | 'paused'

/**
 * Flowise `ExecutionState` → console node-card status.
 *
 * `INPROGRESS` → running; `FINISHED` → done; `ERROR`/`TERMINATED`/`TIMEOUT` →
 * failed; `STOPPED` → paused. Anything unrecognized maps to `idle` (the default
 * for a node that hasn't run in this execution).
 */
export function mapExecutionState(state: string | undefined): NodeRunStatus {
  switch (state) {
    case 'INPROGRESS':
      return 'running'
    case 'FINISHED':
      return 'done'
    case 'ERROR':
    case 'TERMINATED':
    case 'TIMEOUT':
      return 'failed'
    case 'STOPPED':
      return 'paused'
    default:
      return 'idle'
  }
}

/**
 * Parse a flow's `flowData` JSON string into the React Flow object. Returns an
 * empty DAG (`{ nodes: [], edges: [] }`) when the field is missing or malformed
 * — a flow with no canvas shouldn't crash the browse page, it just renders an
 * empty stage. A non-object `flowData` (some legacy rows) also degrades to the
 * empty DAG rather than throwing.
 */
export function parseFlowData(flowData: string | undefined | null): FlowData {
  if (!flowData) return { nodes: [], edges: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(flowData)
  } catch {
    return { nodes: [], edges: [] }
  }
  const result = flowDataSchema.safeParse(parsed)
  if (!result.success) return { nodes: [], edges: [] }
  return result.data
}

/** A node in the rendered DAG, with its run status attached. */
export interface FlowNodeView {
  id: string
  /** Display label (Flowise `data.label`, falling back to the node id). */
  label: string
  /** React Flow node `type` (e.g. `customNode`, `Agent`…). */
  type: string
  position: { x: number; y: number }
  status: NodeRunStatus
}

/** An edge in the rendered DAG. */
export interface FlowEdgeView {
  id: string
  source: string
  target: string
  /** Optional edge label (Flowise `data.label`). */
  label?: string
}

/** The per-node run metrics shown in the inspector. */
export interface NodeRunMetrics {
  nodeId: string
  status: NodeRunStatus
  /** Most recent execution id that touched this node, if any. */
  executionId?: string
  /** Per-node log lines (from the executed node `data`). */
  logs: Array<{ ts: string; level: string; msg: string }>
}

/** A flow's detail for the DAG view: parsed nodes/edges + per-node run state. */
export interface FlowDetailView {
  id: string
  name: string
  type: string
  /** Short version hash (repro snapshot, if available; else ''). */
  versionHash: string
  /** Overall flow status — derived from the latest execution's state. */
  status: NodeRunStatus
  /** Most recent execution id for this flow, if any. */
  latestExecutionId?: string
  /**
   * The latest execution's `sessionId` — which (per the M3.2 convention
   * `overrideConfig.sessionId = runId`) IS the platform run id. Surfaced so the
   * console can fetch that run's node-level trace (M6.4) from the scheduler by
   * the run id the spans were ingested under. Null when there is no latest
   * execution.
   */
  latestRunId?: string | null
  nodes: FlowNodeView[]
  edges: FlowEdgeView[]
  /** Per-node metrics keyed by nodeId (the inspector reads the selected one). */
  nodeMetrics: Record<string, NodeRunMetrics>
  updatedAt: string
}

/** A flow summary row in the list page (v0.3-M2.1 design-fidelity). */
export interface FlowSummary {
  id: string
  name: string
  type: string
  status: NodeRunStatus
  nodeCount: number
  updatedAt: string
  /**
   * Repro version hash (the short sha bound at createRun time), else ''. The
   * design's `.sub` row shows `f.version` (e.g. `v2.3.1`); the platform has no
   * SemVer column on a chatflow, so we surface the repro hash as the closest
   * version signal (empty when there is no snapshot yet).
   */
  versionHash: string
  /**
   * Owner display name. Flowise chatflows carry no owner field; the design
   * assigns owners from a fixed list for the scope-tabs `mine` filter. With no
   * upstream source today this is `null` — the `mine` scope then matches no
   * flow, matching the pre-M2.1 reality (no ownership concept). Surfaced so the
   * UI can render the column + so a later task can wire ownership without
   * changing this shape.
   */
  owner: string | null
  /**
   * Archived flag — derived from the flow's latest status: the design marks a
   * flow `archived` when `status === 'failed' || status === 'paused'`
   * (`agentflows.html:238`). Used by the scope-tabs `archived` filter.
   */
  archived: boolean
  /**
   * Count of recorded executions for this flow (`executionsByFlow[f.id].length`),
   * shown as `N 次运行` in the card `.sub` row. `0` when none.
   */
  runCount: number
  /**
   * The latest execution's id (Flowise `Execution.id`), shown as a chip on the
   * card when the flow has a current run. `undefined` when the flow has no
   * execution.
   */
  latestRunId?: string
}

/**
 * Parse an execution's `executionData` into a node-id → status map, taking the
 * LAST entry per nodeId (executions append per-node entries as the DAG runs, so
 * the last is the most recent status). `executionData` may be a JSON string or
 * an already-parsed array; both are handled. A malformed value yields `{}`.
 */
export function nodeStatusFromExecution(exec: FlowiseExecution): Record<string, NodeRunStatus> {
  const data = exec.executionData
  let arr: FlowiseExecutedNode[] = []
  if (Array.isArray(data)) {
    arr = data as FlowiseExecutedNode[]
  } else if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data)
      if (Array.isArray(parsed)) arr = parsed as FlowiseExecutedNode[]
    } catch {
      arr = []
    }
  }
  const out: Record<string, NodeRunStatus> = {}
  for (const entry of arr) {
    if (!entry?.nodeId) continue
    // last entry wins (most recent status for that node)
    out[entry.nodeId] = mapExecutionState(entry.status)
  }
  return out
}

/**
 * Pick the latest execution for a flow from a list (highest `updatedDate`).
 * Returns `undefined` when the list is empty. Dates may arrive as ISO strings
 * (from JSON) or Date objects (from the pg driver); both compare correctly
 * after `new Date()`.
 */
export function latestExecution(execs: readonly FlowiseExecution[]): FlowiseExecution | undefined {
  if (execs.length === 0) return undefined
  let best = execs[0]!
  let bestTs = toMs(best.updatedDate ?? best.createdDate)
  for (let i = 1; i < execs.length; i++) {
    const ts = toMs(execs[i]!.updatedDate ?? execs[i]!.createdDate)
    if (ts > bestTs) {
      best = execs[i]!
      bestTs = ts
    }
  }
  return best
}

function toMs(d: string | Date): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime()
}

/**
 * Build the flow detail view (DAG nodes/edges + per-node status) from a
 * chatflow and its recent executions. Pure: no fetch, no side effects.
 *
 * The latest execution's per-node statuses paint the DAG; nodes not present in
 * that execution stay `idle`. Per-node metrics are built from every execution
 * that touched the node (most recent first), so the inspector can show the
 * latest run's logs.
 */
export function toFlowDetailView(
  flow: FlowiseChatflow,
  executions: readonly FlowiseExecution[],
  versionHash = '',
): FlowDetailView {
  const dag = parseFlowData(flow.flowData)
  const latest = latestExecution(executions)
  const statusByNode = latest ? nodeStatusFromExecution(latest) : {}

  const nodes: FlowNodeView[] = dag.nodes.map((n) => ({
    id: n.id,
    label: n.data?.label || n.id,
    type: n.type ?? 'customNode',
    position: n.position,
    status: statusByNode[n.id] ?? 'idle',
  }))

  const edges: FlowEdgeView[] = dag.edges.map((e, i) => ({
    id: e.id ?? `e-${e.source}-${e.target}-${i}`,
    source: e.source,
    target: e.target,
    // Flowise stores the edge label either at top-level `label` or nested in
    // `data.label` (both shapes appear across versions); surface whichever is set.
    label: e.label ?? e.data?.label,
  }))

  // Per-node metrics: walk executions most-recent-first, keep the first (latest)
  // status + logs per node. A node untouched by any execution has no entry here;
  // the inspector falls back to an idle state.
  const nodeMetrics: Record<string, NodeRunMetrics> = {}
  const sorted = [...executions].sort(
    (a, b) => toMs(b.updatedDate ?? b.createdDate) - toMs(a.updatedDate ?? a.createdDate),
  )
  for (const exec of sorted) {
    const byNode = nodeStatusFromExecution(exec)
    for (const [nodeId, status] of Object.entries(byNode)) {
      if (nodeMetrics[nodeId]) continue
      nodeMetrics[nodeId] = {
        nodeId,
        status,
        executionId: exec.id,
        logs: extractLogs(exec, nodeId),
      }
    }
  }

  return {
    id: flow.id,
    name: flow.name,
    type: flow.type ?? 'CHATFLOW',
    versionHash,
    status: latest ? mapExecutionState(latest.state) : 'idle',
    latestExecutionId: latest?.id,
    // M3.2 threads `overrideConfig.sessionId = runId` into the prediction body,
    // so the latest execution's sessionId IS the platform run id — the key the
    // scheduler ingested node spans under (M6.4). Surfaced for the node-spans
    // fetch; null when there is no latest execution.
    latestRunId: latest?.sessionId ?? null,
    nodes,
    edges,
    nodeMetrics,
    updatedAt: toIso(flow.updatedDate),
  }
}

/**
 * Build a flow list summary from chatflow rows. Each row's status is `idle`
 * unless executions are provided for it; when they are, the latest execution's
 * state colors the row. Callers pass executions grouped by flow id.
 *
 * v0.3-M2.1: the summary now carries the list-page fidelity fields —
 * `versionHash` (repro snapshot, '' when none), `owner` (null; Flowise has no
 * owner column), `archived` (derived from the latest status: failed/paused →
 * archived, matching `agentflows.html:238`), `runCount` (the execution count),
 * and `latestRunId` (the latest execution's id, for the card's run chip).
 */
export function summarizeFlows(
  flows: readonly FlowiseChatflow[],
  executionsByFlow: Readonly<Record<string, readonly FlowiseExecution[]>>,
  versionHashes: Readonly<Record<string, string>> = {},
): FlowSummary[] {
  return flows.map((f) => {
    const execs = executionsByFlow[f.id] ?? []
    const latest = latestExecution(execs)
    const status: NodeRunStatus = latest ? mapExecutionState(latest.state) : 'idle'
    const dag = parseFlowData(f.flowData)
    return {
      id: f.id,
      name: f.name,
      type: f.type ?? 'CHATFLOW',
      status,
      nodeCount: dag.nodes.length,
      updatedAt: toIso(f.updatedDate),
      versionHash: versionHashes[f.id] ?? '',
      owner: null,
      archived: status === 'failed' || status === 'paused',
      runCount: execs.length,
      latestRunId: latest?.id,
    }
  })
}

/**
 * Pull per-node log lines out of an execution's `executionData` entry. The
 * executed-node `data` blob is opaque (`INodeExecutionData`); Flowise stores
 * node outputs there, which for agent/LLM nodes often include a `logs` or
 * `text` field. We surface a best-effort single log line per node; anything we
 * can't read yields an empty array (the inspector shows "暂无日志").
 */
function extractLogs(
  exec: FlowiseExecution,
  nodeId: string,
): Array<{ ts: string; level: string; msg: string }> {
  const data = exec.executionData
  let arr: FlowiseExecutedNode[] = []
  if (Array.isArray(data)) {
    arr = data as FlowiseExecutedNode[]
  } else if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data)
      if (Array.isArray(parsed)) arr = parsed as FlowiseExecutedNode[]
    } catch {
      arr = []
    }
  }
  const entry = arr.find((e) => e?.nodeId === nodeId)
  if (!entry?.data || typeof entry.data !== 'object') return []
  const d = entry.data as Record<string, unknown>
  const ts = toIso(exec.updatedDate ?? exec.createdDate)
  // Common Flowise node-output keys; not exhaustive — degrade gracefully.
  const msg =
    typeof d.text === 'string' ? d.text
    : typeof d.logs === 'string' ? d.logs
    : typeof d.output === 'string' ? d.output
    : ''
  if (!msg) return []
  return [{ ts, level: entry.status === 'ERROR' ? 'err' : 'info', msg: msg.slice(0, 500) }]
}

function toIso(d: string | Date): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

/** Group a flat list of executions by `agentflowId` (the flow id). */
export function groupExecutionsByFlow(
  execs: readonly FlowiseExecution[],
): Record<string, FlowiseExecution[]> {
  const out: Record<string, FlowiseExecution[]> = {}
  for (const e of execs) {
    const key = e.agentflowId
    if (!out[key]) out[key] = []
    out[key]!.push(e)
  }
  return out
}
