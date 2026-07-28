import { z } from 'zod'

/**
 * Run node-span projection.
 *
 * Lands the *node* level: each node a workflow engine executes becomes a
 * queryable span tied back to the run, so the AgentFlows browse page can show
 * per-node status + duration + token/cost without re-reading live execution
 * data on every render.
 *
 * ## Source — the prediction response carries the trace
 *
 * The workflow prediction response includes execution id + node trace array —
 * the per-node trace appended as the DAG runs. So after a run's prediction
 * completes, the scheduler has the full node trace IN the response — no
 * extra fetch and no run↔execution correlation ambiguity (the response is
 * the run's own). This module projects that array into `NodeSpanInput` rows
 * for `run_node_spans`.
 *
 * ## Lifecycle
 *
 * Pure data transform: no DB writes here (those live in `run-node-spans.ts`).
 * Keeping the projection as a pure function means the shape contract is unit-
 * testable without a DB.
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
 * Execution state → `run_node_spans.status`.
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
 * Best-effort zod parse of one executed-node entry. The trace carries more
 * than we read; we keep only the fields the projection needs and let the
 * rest through opaquely. A failed parse yields `null` so a single malformed
 * entry can't abort the whole projection.
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
 * Project a node trace array into node-span rows.
 *
 * `nodeTrace` is the per-node trace appended as the DAG runs (returned
 * verbatim in the prediction response). We take the LAST entry per `nodeId`
 * (the array is append-as-it-runs, so the last is the node's most recent
 * status) and map each onto one {@link NodeSpanInput}. Spans are returned in
 * first-seen order.
 *
 * Timing: if the trace doesn't record per-node start/finish timestamps,
 * `startedAt` is null and `durationMs` is null. The caller stamps
 * `finishedAt` from the run's completion time. These fields are nullable in
 * the schema precisely because not all engines populate them; the inspector
 * shows "—" for unknowns rather than a fabricated value.
 *
 * Token/cost/nodeType — where they actually live in a finished node's `data`:
 *   - `tokens`  ← `data.output.usageMetadata` (the per-node token/cost map)
 *   - `cost`    ← `data.output.usageMetadata.total_cost` (best-effort numeric)
 *   - `nodeType`← `data.name` (the node name / type identifier)
 *   - `error`   ← `data.error` (stamped on an ERROR/TERMINATED node)
 *
 * `finishedAt` is null here — the caller (scheduler) stamps it from the run's
 * completion time when it has one, since the projection is pure and timeless.
 */
export function projectNodeSpans(args: {
  runId: string
  flowId: string
  executionId: string | null
  nodeTrace: unknown
  traceId?: string | null
  finishedAt?: Date | null
}): NodeSpanInput[] {
  const entries = Array.isArray(args.nodeTrace)
    ? (args.nodeTrace as unknown[])
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
    const output = isRecord(data?.output) ? data!.output : null
    const usageMeta = isRecord(output?.usageMetadata) ? output!.usageMetadata : null
    out.push({
      runId: args.runId,
      flowId: args.flowId,
      executionId: args.executionId,
      nodeId,
      nodeLabel: typeof node.nodeLabel === 'string' ? node.nodeLabel : null,
      nodeType: typeof data?.name === 'string' ? data.name : null,
      status: mapNodeSpanStatus(node.status),
      startedAt: null,
      finishedAt,
      durationMs: null,
      tokens: usageMeta ?? null,
      cost: toNumberOrNull(usageMeta?.total_cost),
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
