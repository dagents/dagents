import { currentTraceId, createLogger, type Logger } from '@dagents/shared'
import { projectNodeSpans, type NodeSpanInput } from './node-spans.js'
import { writeRunNodeSpans } from './run-node-spans.js'

/**
 * Scheduler → run_node_spans ingest.
 *
 * Lands the *node* level: each node a workflow engine executes becomes a
 * queryable span tied back to the run, so the AgentFlows browse page can show
 * per-node status without re-reading live execution data on every render.
 *
 * ## Source — the prediction response carries the trace
 *
 * The workflow prediction response includes execution id + per-node trace
 * array — the per-node trace appended as the DAG runs. So after a run's
 * prediction completes, the scheduler has the full node trace IN the
 * response — no extra fetch and no run↔execution correlation ambiguity
 * (the response is the run's own).
 *
 * ## Lifecycle
 *
 * Best-effort: a failure logs + returns 0, never throws — called from the
 * run-completion path where a span-write failure must not re-fail the run
 * (node-level trace is an observability projection, not a run-lifecycle
 * concern; same posture as the audit hook + archive hook).
 */

const log = createLogger({ svc: 'scheduler:node-spans' })

/**
 * Read the node trace data out of a prediction response. Returns `null` when
 * the response doesn't carry a node trace (e.g. a run type that doesn't
 * produce per-node spans) — the caller then skips ingest.
 *
 * The array arrives already-parsed in the prediction response (the scheduler's
 * `PredictionResult.output` is `await res.json()`). We do NOT JSON.parse here.
 *
 * Supported response shapes (checked in order):
 *   - `{ agentFlowExecutedData, executionId }` — legacy agentflow-style trace
 *   - `{ executionData, executionId }` — generic execution trace
 */
export function readNodeTrace(
  output: unknown,
): { executionId: string | null; nodeTrace: unknown } | null {
  if (!output || typeof output !== 'object') return null
  const obj = output as Record<string, unknown>
  const data = obj.agentFlowExecutedData ?? obj.executionData
  if (data === undefined) return null
  const executionId =
    typeof obj.executionId === 'string' ? obj.executionId : null
  return { executionId, nodeTrace: data }
}

/**
 * Ingest node spans for a run from its prediction response.
 *
 * Extracts the node trace from the prediction output, projects it into spans,
 * and persists them. No-op when the output carries no node trace (a run type
 * that doesn't produce per-node spans). Best-effort: a failure logs + returns
 * 0, never throws.
 *
 * `traceId` defaults to the active OTel span's traceId (`currentTraceId()`) so
 * the end-to-end trace correlation is wired without each caller threading it
 * explicitly; pass `null` to force-absent, or a value to override.
 * `finishedAt` is stamped from the run's completion time (the caller has it)
 * since the projection is pure and the engine records no per-node timestamps.
 */
export async function ingestRunNodeSpans(args: {
  runId: string
  flowId: string
  output: unknown
  traceId?: string | null
  finishedAt?: Date | null
}): Promise<number> {
  const trace = readNodeTrace(args.output)
  if (!trace) {
    log.debug('prediction output has no node trace; skipping node spans', {
      runId: args.runId,
    })
    return 0
  }
  const traceId = args.traceId !== undefined ? args.traceId : currentTraceId() ?? null
  const spans: NodeSpanInput[] = projectNodeSpans({
    runId: args.runId,
    flowId: args.flowId,
    executionId: trace.executionId,
    nodeTrace: trace.nodeTrace,
    traceId,
    finishedAt: args.finishedAt ?? null,
  })
  if (spans.length === 0) return 0
  return writeRunNodeSpans(spans)
}

/**
 * Best-effort node-span ingest: never throws, logs on failure. Shared by the
 * worker (single-run) and fan-out (per-child) completion paths so the
 * posture + traceId/finishedAt wiring lives in one place, not duplicated.
 *
 * `traceId` defaults to the active span's traceId (the caller runs inside the
 * run-entry span); `finishedAt` defaults to now — both overridable. A span
 * write failure logs a warn and never re-fails the already-completed run (node
 * trace is an observability projection, not a run-lifecycle concern; same
 * posture as the archive / audit hooks).
 */
export async function ingestNodeSpansBestEffort(args: {
  runId: string
  flowId: string
  output: unknown
  logger?: Logger
  traceId?: string | null
  finishedAt?: Date | null
}): Promise<void> {
  try {
    const n = await ingestRunNodeSpans({
      runId: args.runId,
      flowId: args.flowId,
      output: args.output,
      traceId: args.traceId,
      finishedAt: args.finishedAt ?? new Date(),
    })
    if (n > 0) {
      ;(args.logger ?? log).info('node spans ingested', {
        runId: args.runId,
        flowId: args.flowId,
        count: n,
      })
    }
  } catch (err) {
    ;(args.logger ?? log).warn('node span ingest hook threw unexpectedly', {
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
