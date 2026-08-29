/**
 * Run node-span client + types.
 *
 * The console AgentFlows browse page reads a run's node-level trace from the
 * gateway → scheduler passthrough
 * (`/api/v1/scheduler/runs/:runId/node-spans` → scheduler). This module owns
 * the console domain type for a node span + the pure mapping from the
 * scheduler's row shape onto it, kept separate from `flows.ts` because the
 * source is the platform's own DB (via scheduler), not live execution data
 * — different trust boundary, different fetch path.
 *
 * The browser hits the console's own
 * `/api/workflows/runs/:runId/node-spans` route (server-side), which fetches
 * the gateway; the gateway URL + the scheduler's row shape never reach the
 * client bundle.
 */

/** Console node-span status — the same domain as `NodeRunStatus` in flows.ts. */
export type NodeSpanStatus = 'running' | 'done' | 'failed' | 'paused' | 'unknown'

/** A node-level span for a run, as the inspector renders it. */
export interface RunNodeSpan {
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
  status: NodeSpanStatus
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  /** Per-model token usage, when reported; null when none. */
  tokens: unknown
  /** Monetary cost; NUMERIC arrives as a string, coerced to number here. */
  cost: number | null
  error: string | null
  /** OTel traceId (M6.1) for end-to-end trace correlation; null when none. */
  traceId: string | null
  /** 节点实际输入（JSONB — model, systemPrompt, userMessage 等） */
  input?: Record<string, unknown> | null
  /** 节点实际输出（JSONB — text, content 等） */
  output?: Record<string, unknown> | null
}

/** The scheduler's `run_node_spans` row shape (only the fields the console reads). */
export interface SchedulerNodeSpanRow {
  nodeId: string
  nodeLabel: string | null
  nodeType: string | null
  status: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  tokens: unknown
  /** NUMERIC → pg returns string; coerced to number (null on parse failure). */
  cost: string | null
  error: string | null
  traceId: string | null
  input?: Record<string, unknown> | null
  output?: Record<string, unknown> | null
}

/** The envelope the scheduler's node-spans route returns. */
export interface NodeSpansEnvelope {
  success: boolean
  data?: {
    runId: string
    spans: SchedulerNodeSpanRow[]
    /** runs 行的状态（completed/failed/cancelled 终态；running 或无行时
     *  null/undefined）—— 旁观端据此判断轮询何时收尾（画布 watchLoop
     *  同款契约）。 */
    runStatus?: string | null
    runDurationMs?: number | null
  }
  error?: string
}

/**
 * Map a scheduler `run_node_spans.status` onto the console's node-span status.
 * The scheduler stores the same domain (`running|done|failed|paused|unknown`),
 * so this is a pass-through that keeps the boundary explicit + degrades unknown
 * values to `unknown` rather than crashing the inspector on a future status.
 */
export function mapSpanStatus(status: string): NodeSpanStatus {
  switch (status) {
    case 'running':
    case 'done':
    case 'failed':
    case 'paused':
    case 'unknown':
      return status
    default:
      return 'unknown'
  }
}

/** Coerce a NUMERIC-as-string cost to a number, null when absent / unparseable. */
function toCost(v: string | null): number | null {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Pure transform: scheduler row → console span. Kept pure so the shape contract
 * is unit-testable without a gateway (mirrors `flows.ts` transforms).
 */
export function toRunNodeSpan(row: SchedulerNodeSpanRow): RunNodeSpan {
  return {
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    nodeType: row.nodeType,
    status: mapSpanStatus(row.status),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    tokens: row.tokens ?? null,
    cost: toCost(row.cost),
    error: row.error,
    traceId: row.traceId,
    input: row.input ?? null,
    output: row.output ?? null,
  }
}

/** A node-span poll result: the trace + the runs-row status for loop control. */
export interface RunNodeSpansResult {
  spans: RunNodeSpan[]
  /** 终态判断依据（见 NodeSpansEnvelope.runStatus）。 */
  runStatus: string | null
}

/** Fetch a run's node spans through the console's own API route (server-side).
 *  Returns the spans together with the runs-row status so polling callers can
 *  decide when to stop; one-shot callers can ignore `runStatus`. */
export async function fetchRunNodeSpans(runId: string): Promise<RunNodeSpansResult> {
  const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/node-spans`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) {
    // 404 (run has no spans / not found) + 5xx both degrade to an empty list —
    // the inspector shows the execution-derived status + "—" rather than crashing.
    return { spans: [], runStatus: null }
  }
  const json = (await res.json()) as NodeSpansEnvelope
  const rows = json.data?.spans ?? []
  return { spans: rows.map(toRunNodeSpan), runStatus: json.data?.runStatus ?? null }
}
