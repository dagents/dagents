import { z } from 'zod'

/**
 * Flowise run node-span projection (plan M6.4 / P1.11.T5).
 *
 * M6.1 threads one OTel traceId across gateway→flowise→daemon→LLM at the
 * *service* level. M6.4 lands the *node* level: each node a Flowise agentflow
 * executes becomes a queryable span tied back to the run, so the AgentFlows
 * browse page can show per-node status + duration + token/cost without
 * re-reading Flowise's live `executionData` on every render.
 *
 * ## Source — the prediction response carries the trace
 *
 * Flowise's agentflow prediction response (`executeAgentFlow` return) includes
 * `executionId` + `agentFlowExecutedData` — the per-node trace array Flowise
 * appends as the DAG runs (`IAgentflowExecutedData` = `{ nodeId, nodeLabel,
 * data, previousNodeIds, status }`). So after a run's prediction completes, the
 * scheduler has the full node trace IN the response — no extra Flowise fetch and
 * no run↔execution correlation ambiguity (the response is the run's own). This
 * module projects that array into `NodeSpanInput` rows for `run_node_spans`.
 *
 * ## Lifecycle
 *
 * Pure data transform: no DB writes here (those live in `run-node-spans.ts`).
 * Keeping the projection as a pure function means the shape contract is unit-
 * testable without a DB, mirroring the console's `lib/flows.ts` transforms.
 */

/** One node's projected span, ready to persist to `run_node_spans`. */
export interface NodeSpanInput {
  runId: string
  flowId: string
  executionId: string | null
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
  status: NodeSpanStatus
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
  tokens: unknown
  cost: number | null
  error: string | null
  traceId: string | null
}

export type NodeSpanStatus = 'running' | 'done' | 'failed' | 'paused' | 'unknown'

/**
 * Flowise `ExecutionState` → `run_node_spans.status`.
 *
 * `INPROGRESS` → running; `FINISHED` → done; `ERROR`/`TERMINATED`/`TIMEOUT` →
 * failed; `STOPPED` → paused (human-intervention pause); anything else (incl.
 * a missing state) → unknown, kept distinct from `done` so the inspector can
 * flag an unrecognised outcome rather than silently green-lighting a node.
 */
export function mapNodeSpanStatus(state: string | undefined): NodeSpanStatus {
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
      return 'unknown'
  }
}

/**
 * Best-effort zod parse of one Flowise executed-node entry. Flowise's
 * `IAgentflowExecutedData` carries more than we read; we keep only the fields
 * the projection needs and let the rest through opaquely. A failed parse yields
 * `null` so a single malformed entry can't abort the whole projection.
 */
const executedNodeSchema = z
  .object({
    nodeId: z.string(),
    nodeLabel: z.string().optional(),
    status: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough()

/** A best-effort parsed executed-node entry (null when malformed). */
type ParsedExecutedNode = z.infer<typeof executedNodeSchema> | null

function parseNode(v: unknown): ParsedExecutedNode {
  const r = executedNodeSchema.safeParse(v)
  return r.success ? r.data : null
}

/**
 * Project a Flowise `agentFlowExecutedData` array into node-span rows.
 *
 * `agentFlowExecutedData` is the per-node trace Flowise appends as the DAG runs
 * (returned verbatim in the prediction response). We take the LAST entry per
 * `nodeId` (the array is append-as-it-runs, so the last is the node's most
 * recent status) and map each onto one {@link NodeSpanInput}. Spans are
 * returned in first-seen order.
 *
 * Timing: Flowise does not record per-node start/finish timestamps in the
 * executed-data blob, so `startedAt` is always null and `durationMs` is null
 * (per-node wall-clock isn't derivable from the prediction response alone). The
 * caller stamps `finishedAt` from the run's completion time. These fields are
 * nullable in the schema precisely because Flowise doesn't populate them; the
 * inspector shows "—" for unknowns rather than a fabricated value.
 *
 * Token/cost/nodeType — where they actually live in a finished node's `data`:
 *
 * Flowise pushes `nodeResult = node.run()` as each entry's `data`
 * (`vendor/.../buildAgentflow.ts`). For an Agent/LLM node that return is
 * `{ id, name, input, output: { content, timeMetadata, usageMetadata } }`
 * (`vendor/.../agentflow/Agent/Agent.ts` `prepareOutputObject`). So:
 *   - `tokens`  ← `data.output.usageMetadata` (the per-node token/cost map,
 *                 incl. `input_tokens`/`output_tokens`/`total_tokens` and, when
 *                 cost accounting is on, `input_cost`/`total_cost`).
 *   - `cost`    ← `data.output.usageMetadata.total_cost` (best-effort numeric).
 *   - `nodeType`← `data.name` (the Flowise node *name*, e.g. `agentAgentflow` —
 *                 the closest thing to a node type the executed-data carries;
 *                 the React Flow `type` is not written into executed-data).
 *   - `error`   ← `data.error` (Flowise stamps `{ id, name, error }` on an
 *                 ERROR/TERMINATED node — see `buildAgentflow.ts`).
 * Flowise's own evaluation runner reads the same path
 * (`agentFlowExecutedData[i].data?.output?.usageMetadata?.input_tokens`,
 * `vendor/.../evaluation/EvaluationRunner.ts`) — the decisive shape cross-check
 * for these reads.
 *
 * `finishedAt` is null here — the caller (scheduler) stamps it from the run's
 * completion time when it has one, since the projection is pure and timeless.
 */
export function projectNodeSpans(args: {
  runId: string
  flowId: string
  executionId: string | null
  agentFlowExecutedData: unknown
  traceId?: string | null
  finishedAt?: Date | null
}): NodeSpanInput[] {
  const entries = Array.isArray(args.agentFlowExecutedData)
    ? (args.agentFlowExecutedData as unknown[])
    : []

  const byNode = new Map<string, NonNullable<ParsedExecutedNode>>()
  for (const raw of entries) {
    const node = parseNode(raw)
    if (!node?.nodeId) continue
    byNode.set(node.nodeId, node) // last wins
  }

  const traceId = args.traceId ?? null
  const finishedAt = args.finishedAt ?? null
  const out: NodeSpanInput[] = []
  for (const [nodeId, node] of byNode) {
    const data: Record<string, unknown> | null = isRecord(node.data) ? node.data : null
    // token/cost live under `data.output.usageMetadata` for finished Agent/LLM
    // nodes (see module doc). `data.output` may be absent on non-agent nodes
    // (Start / Condition / Direct Reply) — those yield null tokens/cost, which
    // is correct (they don't call an LLM).
    const output = isRecord(data?.output) ? data!.output : null
    const usageMeta = isRecord(output?.usageMetadata) ? output!.usageMetadata : null
    out.push({
      runId: args.runId,
      flowId: args.flowId,
      executionId: args.executionId,
      nodeId,
      nodeLabel: typeof node.nodeLabel === 'string' ? node.nodeLabel : null,
      // `data.name` is the Flowise node name (e.g. 'agentAgentflow'); the React
      // Flow `type` isn't written into executed-data, so name is the closest
      // type-like field a finished node carries.
      nodeType: typeof data?.name === 'string' ? data.name : null,
      status: mapNodeSpanStatus(node.status),
      startedAt: null,
      finishedAt,
      durationMs: null,
      tokens: usageMeta ?? null,
      cost: toNumberOrNull(usageMeta?.total_cost),
      // ERROR/TERMINATED nodes carry `data.error` (buildAgentflow.ts); finished
      // nodes have no `error` key, so this is null for them — correct.
      error: typeof data?.error === 'string' ? data.error : null,
      traceId,
    })
  }
  return out
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
