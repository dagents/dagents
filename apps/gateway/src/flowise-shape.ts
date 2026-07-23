import { z } from 'zod'
import { flowiseChatflowSchema, type FlowiseChatflow } from './routes/workspace-flowise.js'

/**
 * v0.3-M9.2 — gateway chatflows 代理返回 flows-data DAG 形状 (14 节点类型映射).
 *
 * Design source: `design/js/flows-data.js` (the Agentflow V2 sample DAGs the
 * `agentflows.html` detail page renders). A flow there is
 *
 *   { id, name, version, hash, status, run, nodes:[{id,type,…}], edges:[{from,to,label?}], runs:[…] }
 *
 * Flowise stores the DAG as a React Flow `flowData` JSON string on the
 * `ChatFlow` row (`flowData = "{ nodes:[{id,position,type,data:{name,label,…}}], edges:[{source,sourceHandle,target,targetHandle,type,data:{label}}], viewport }"`).
 * The agentflow node *identity* lives in `data.name` (e.g. `startAgentflow`,
 * `agentAgentflow` …) — NOT in the React Flow `type` field, which is only the
 * renderer kind (`agentFlow` for normal nodes, `iteration` for iteration
 * bodies, `stickyNote` for sticky notes). The 14 agentflow node classes
 * (`vendor/flowise/packages/components/nodes/agentflow/*`) each set
 * `this.name = '<x>Agentflow'` + `this.type = '<Design>'`; the map below is the
 * inverse of that, so a flow saved by the Flowise canvas round-trips back to
 * the design `type` vocabulary the console + audit expect.
 *
 * This module is the **gateway-side** mirror of the console's
 * `apps/console/src/lib/flows.ts` `toFlowDetailView` — but the gateway returns
 * the *design* shape (`nodes:[{id,type,…}]`, `edges:[{from,to,label?}]`,
 * `runs`) instead of the console's `FlowNodeView`/`FlowEdgeView`, so the
 * console can later switch to fetching the gateway directly for the
 * design-fidelity detail page (M9 milestone) without a shape translation hop.
 *
 * The execution-parsing helpers (`flowiseExecutionSchema`, `mapExecutionState`,
 * `latestExecution`, `nodeStatusFromExecution`) are duplicated locally rather
 * than imported from the console — the gateway must not depend on the console
 * (the dependency direction in CLAUDE.md is `contracts ← gateway`, never
 * `console → gateway`), and `workspace-flowise.ts` already keeps its own copy
 * of `flowiseChatflowSchema` for the same reason.
 *
 * Pure: no fetch, no side effects. The route (`app.ts` `/api/v1/flows/:id`)
 * owns the Flowise dial; this owns the shape.
 */

// ─── Flowise native flowData source shape (only the fields we read) ──────────

/** One entry in an execution's per-node trace (Flowise `IAgentflowExecutedData`). */
const flowiseExecutedNodeSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string().optional(),
  status: z.string().optional(),
  data: z.unknown().optional(),
  previousNodeIds: z.array(z.string()).optional(),
})
type FlowiseExecutedNode = z.infer<typeof flowiseExecutedNodeSchema>

/** A Flowise `Execution` row (only the fields the shape map reads). */
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
  // React Flow renderer kind: `agentFlow` for normal agentflow nodes,
  // `iteration` for iteration bodies, `stickyNote` for sticky notes. NOT the
  // agentflow node identity — that's `data.name`.
  type: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  data: z
    .object({
      // The agentflow node identity (e.g. `startAgentflow`). Set by
      // `initNode` (vendor ui/utils/genericHelper.js) from the component
      // node's `this.name`. This is the key the 14-type map reads.
      name: z.string().optional(),
      label: z.string().optional(),
      // The component node's `this.type` (e.g. `Start`), carried through
      // `data.type`. Present on agentflow nodes; used as a fallback if the
      // `data.name` → design-type map misses (a future node type).
      type: z.string().optional(),
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
  // Flowise writes the edge label into `data.label` (Canvas.jsx onConnect);
  // a bare top-level `label` is tolerated too for older saved flows.
  label: z.string().optional(),
  data: z.object({ label: z.string().optional() }).optional(),
})

const flowDataSchema = z.object({
  nodes: z.array(flowDataNodeSchema).default([]),
  edges: z.array(flowDataEdgeSchema).default([]),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
})
type FlowData = z.infer<typeof flowDataSchema>

/**
 * Parse a flow's `flowData` JSON string into the React Flow object. Returns an
 * empty DAG (`{ nodes: [], edges: [] }`) when the field is missing or malformed
 * — a flow with no canvas shouldn't crash the shape map, it just yields an empty
 * DAG. A non-object `flowData` (some legacy rows) also degrades to the empty
 * DAG rather than throwing. Mirrors the console's `parseFlowData` so the two
 * sides agree on the empty-DAG contract.
 */
function parseFlowData(flowData: string | undefined | null): FlowData {
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

// ─── The 14 agentflow node `data.name` → design `type` map ───────────────────

/**
 * Flowise agentflow node `data.name` → design node `type`. The 14 entries are
 * the complete agentflow **DAG-semantic** node set
 * (`vendor/flowise/packages/components/nodes/agentflow/*`); each node class
 * sets `this.name = '<x>Agentflow'` + `this.type = '<Design>'`, and the canvas
 * stores the `name` on `data.name` when a node is dropped
 * (`Canvas.jsx` onDrop → `initNode`). The design `flows-data.js` uses the
 * design type vocabulary (`Start`, `Agent`, …), so this is the inverse map.
 *
 * StickyNote (`stickyNoteAgentflow`, `this.type='StickyNote'`) is deliberately
 * **excluded** — it is a canvas annotation, not a DAG-semantic node, and the
 * design vocabulary (`design/js/flows-data.js:3-5`) has no StickyNote type.
 * It is filtered out in `mapFlowiseToDesignShape` before mapping; it must NOT
 * appear in this map (a StickyNote here would surface it as a 15th design
 * type, polluting the shape contract this route exists to enforce).
 *
 * Source of truth (one line per node, vendor tree). The `this.type` column is
 * the **vendor** value as-written in the source (camelCase, no spaces); the map
 * *value* is the design word (spaces, matching `flows-data.js`). They differ
 * for the 5 multi-word types — that is expected: the map's job is to emit the
 * design word, not echo the vendor token. The `data.type` fallback in
 * `mapNodeNameToType` reads the vendor token, so for the 14 mapped names the
 * fallback never fires (the name always hits the map first).
 *
 *   Start/Start.ts             this.name='startAgentflow'            this.type='Start'
 *   Agent/Agent.ts             this.name='agentAgentflow'            this.type='Agent'
 *   LLM/LLM.ts                 this.name='llmAgentflow'              this.type='LLM'
 *   Tool/Tool.ts               this.name='toolAgentflow'            this.type='Tool'
 *   HTTP/HTTP.ts               this.name='httpAgentflow'             this.type='HTTP'
 *   Condition/Condition.ts     this.name='conditionAgentflow'       this.type='Condition'
 *   ConditionAgent/…           this.name='conditionAgentAgentflow'  this.type='ConditionAgent'   → design 'Condition Agent'
 *   Iteration/Iteration.ts     this.name='iterationAgentflow'       this.type='Iteration'
 *   Loop/Loop.ts               this.name='loopAgentflow'            this.type='Loop'
 *   HumanInput/HumanInput.ts   this.name='humanInputAgentflow'      this.type='HumanInput'        → design 'Human Input'
 *   DirectReply/DirectReply.ts this.name='directReplyAgentflow'     this.type='DirectReply'       → design 'Direct Reply'
 *   CustomFunction/…           this.name='customFunctionAgentflow'  this.type='CustomFunction'    → design 'Custom Function'
 *   ExecuteFlow/ExecuteFlow.ts this.name='executeFlowAgentflow'     this.type='ExecuteFlow'       → design 'Execute Flow'
 *   Retriever/Retriever.ts     this.name='retrieverAgentflow'       this.type='Retriever'
 *   (StickyNote/StickyNote.ts  this.name='stickyNoteAgentflow'      this.type='StickyNote'        → EXCLUDED, decorative)
 */
export const AGENTFLOW_NODE_TYPE_MAP: Readonly<Record<string, string>> = {
  startAgentflow: 'Start',
  agentAgentflow: 'Agent',
  llmAgentflow: 'LLM',
  toolAgentflow: 'Tool',
  httpAgentflow: 'HTTP',
  conditionAgentflow: 'Condition',
  conditionAgentAgentflow: 'Condition Agent',
  iterationAgentflow: 'Iteration',
  loopAgentflow: 'Loop',
  humanInputAgentflow: 'Human Input',
  directReplyAgentflow: 'Direct Reply',
  customFunctionAgentflow: 'Custom Function',
  executeFlowAgentflow: 'Execute Flow',
  retrieverAgentflow: 'Retriever',
}

/**
 * `data.name` of the StickyNote agentflow node. It's a canvas annotation, not
 * a DAG-semantic node (the design `flows-data.js` vocabulary has no StickyNote
 * type), so it's filtered out of the design `nodes` before mapping. Kept as a
 * named const so the filter and the test reference the same literal.
 */
export const STICKYNOTE_NODE_NAME = 'stickyNoteAgentflow'

/**
 * Resolve a node's design `type` from its Flowise `data.name` (the agentflow
 * node identity). A recognized name maps to the design type vocabulary; an
 * unrecognized name (a future node type Flowise adds before this map is
 * updated) surfaces verbatim so it's visible rather than silently blanked — the
 * console can still render it, and the gap shows up in a fidelity re-audit.
 * StickyNote is NOT routed through here — it's filtered upstream
 * (`mapFlowiseToDesignShape`), so it never reaches the "unrecognized name
 * surfaces verbatim" branch (which would otherwise pollute the shape with a
 * 15th, non-design type).
 *
 * When `data.name` is absent (an older/foreign flow shape), falls back to
 * `data.type` (the vendor `this.type` token, camelCase for multi-word types),
 * then to the React Flow `type`, then to `'customNode'` (matching the
 * console's `toFlowDetailView` fallback so the two sides agree).
 */
export function mapNodeNameToType(node: {
  type?: string
  data?: { name?: string; type?: string } | null
}): string {
  const name = node.data?.name
  if (name && AGENTFLOW_NODE_TYPE_MAP[name]) return AGENTFLOW_NODE_TYPE_MAP[name]!
  if (name) return name // unrecognized → surface verbatim (no silent drop)
  return node.data?.type ?? node.type ?? 'customNode'
}

// ─── Execution → node status (mirrors console's flows.ts) ────────────────────

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

// ─── Design shape output types ───────────────────────────────────────────────

/**
 * A node in the design DAG. Carries the full design node field set
 * (`flows-data.js` L16): `id` + `type` are the required minimum the M9.2
 * acceptance asserts; the rest (`label`, `sub`, `x`/`y`, `w`/`h`, `status`,
 * `runId`, `duration`, `input`, `output`, `logs`, and the agent-type extras
 * `agent`/`budget`/`tokens`/`cost`/`timeout`) are surfaced best-effort from
 * what Flowise actually stores, so a later fidelity task can light them up
 * without reshaping this contract.
 */
export interface DesignNode {
  id: string
  type: string
  label?: string
  sub?: string
  x?: number
  y?: number
  w?: number
  h?: number
  status: NodeRunStatus
  runId?: string
  duration?: string
  input?: unknown
  output?: unknown
  logs?: Array<{ t: string; l: string; m: string }>
  // agent-type node extras (design L18) — undefined unless Flowise carries them.
  agent?: string
  budget?: string
  tokens?: string
  cost?: string
  timeout?: string
}

/** An edge in the design DAG: `{ from, to, label? }` (design L27-37). */
export interface DesignEdge {
  from: string
  to: string
  label?: string
}

/**
 * A run row in the design run-history panel (`agentflows.html:245-272`). The
 * M9.2 acceptance only requires the `runs` array to exist on the shape; these
 * fields mirror the design run-row so the detail page's run list can render
 * from the gateway directly.
 */
export interface DesignRun {
  id: string
  status: NodeRunStatus
  trigger?: string
  duration?: string
  cost?: string
  time?: string
  version?: string
  hash?: string
}

/** The design `flows-data` flow shape the gateway returns for `/api/v1/flows/:id`. */
export interface DesignFlowShape {
  id: string
  name: string
  version: string
  hash: string
  status: NodeRunStatus
  /** Current run id (`R-####`), or `null` when there is no active execution. */
  run: string | null
  nodes: DesignNode[]
  edges: DesignEdge[]
  runs: DesignRun[]
}

// ─── The pure map ─────────────────────────────────────────────────────────────

/**
 * Build the design `flows-data` DAG shape from a Flowise chatflow row + its
 * recent executions. Pure: no fetch, no side effects.
 *
 * - `flow.flowData` (React Flow `{nodes,edges}`) → design `nodes`/`edges`.
 * - the latest execution's per-node trace paints each node's `status`; nodes
 *   not present in that execution stay `idle` (the design default).
 * - executions become `runs` (the run-history panel rows); the latest
 *   execution's `sessionId` (which is the platform run id, per the M3.2
 *   `overrideConfig.sessionId = runId` convention) is the flow's current `run`.
 * - `version`/`hash` are '' unless a repro snapshot is bound (the platform
 *   has no SemVer column on a chatflow); the design shows them on the canvas
 *   header, so the fields are present even when empty.
 *
 * Mirrors the console's `toFlowDetailView` but emits the design vocabulary
 * (`{from,to}` edges, `{id,type,…}` nodes, `runs[]`) the M9 contract wants.
 */
export function mapFlowiseToDesignShape(
  flow: FlowiseChatflow,
  executions: readonly FlowiseExecution[],
  versionHash = '',
): DesignFlowShape {
  const dag = parseFlowData(flow.flowData)
  const latest = latestExecution(executions)
  const statusByNode = latest ? nodeStatusFromExecution(latest) : {}

  // StickyNote nodes are decorative canvas annotations (`this.type='StickyNote'`,
  // stored as RF `type='stickyNote'` + `data.name='stickyNoteAgentflow'`), not
  // DAG-semantic nodes — the design `flows-data.js` vocabulary has no StickyNote
  // type, so they're filtered out before mapping. Dropping them here keeps the
  // shape's `nodes[]` to the 14 design types exactly (a StickyNote would
  // otherwise hit the "unrecognized name surfaces verbatim" branch in
  // `mapNodeNameToType` and pollute the contract with a 15th type).
  const semanticNodes = dag.nodes.filter(
    (n) =>
      n.data?.name !== STICKYNOTE_NODE_NAME && n.type !== 'stickyNote',
  )

  const nodes: DesignNode[] = semanticNodes.map((n) => {
    const id = n.id
    const status = statusByNode[id] ?? 'idle'
    return {
      id,
      type: mapNodeNameToType(n),
      label: n.data?.label,
      x: n.position?.x,
      y: n.position?.y,
      w: n.width,
      h: n.height,
      status,
      // The latest execution's sessionId IS the platform run id (M3.2); surface
      // it per-node only for nodes the latest execution touched.
      runId: statusByNode[id] && latest?.sessionId ? latest.sessionId : undefined,
    }
  })

  // Edges inside an Iteration body: React Flow stores the iteration's child
  // nodes as top-level `flowData.nodes` with a `parentNode` field pointing at
  // the iteration node (see `Canvas.jsx` onConnect `isWithinIterationNode`).
  // We do NOT fold those children into the iteration node here — they're
  // surfaced as independent top-level design nodes, which differs from the
  // design `flows-data.js` single-node iteration shape. M9.2's acceptance
  // (14 node types + `{id,name,nodes,edges,runs}` shape) does not assert node
  // count == design node count, so this is a known fidelity gap, not a bug;
  // the fold-vs-passthrough decision is deferred to a follow-up task.
  const edges: DesignEdge[] = dag.edges.map((e) => ({
    from: e.source,
    to: e.target,
    // Flowise stores the edge label in `data.label` (Canvas.jsx onConnect);
    // a bare top-level `label` is tolerated for older saved flows.
    label: e.label ?? e.data?.label,
  }))

  // runs: newest-first (the design run-history panel shows the current run on
  // top). The `sessionId` is the platform run id; `state` → design status.
  const sorted = [...executions].sort(
    (a, b) => toMs(b.updatedDate ?? b.createdDate) - toMs(a.updatedDate ?? a.createdDate),
  )
  const runs: DesignRun[] = sorted.map((exec) => ({
    id: exec.sessionId ?? exec.id,
    status: mapExecutionState(exec.state),
    time: toIso(exec.updatedDate ?? exec.createdDate),
  }))

  return {
    id: flow.id,
    name: flow.name,
    version: versionHash,
    hash: versionHash,
    status: latest ? mapExecutionState(latest.state) : 'idle',
    run: latest?.sessionId ?? null,
    nodes,
    edges,
    runs,
  }
}

// Re-export the Flowise source schema the route uses to parse the chatflow row,
// so the route + tests go through one zod boundary.
export { flowiseChatflowSchema }
export type { FlowiseChatflow }

function toMs(d: string | Date): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime()
}

function toIso(d: string | Date): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}
