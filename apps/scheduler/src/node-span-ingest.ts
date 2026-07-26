import { currentTraceId, createLogger, type Logger } from '@dagents/shared'
import { projectNodeSpans, type NodeSpanInput } from './node-spans.js'
import { writeRunNodeSpans } from './run-node-spans.js'

/**
 * Scheduler → run_node_spans ingest (plan M6.4 / P1.11.T5).
 *
 * M6.1 threads one OTel traceId across gateway→flowise→daemon→LLM at the
 * *service* level. M6.4 lands the *node* level: each node a Flowise agentflow
 * executes becomes a queryable span tied back to the run, so the AgentFlows
 * browse page can show per-node status without re-reading Flowise's live
 * `executionData` on every render.
 *
 * ## Source — the prediction response carries the trace
 *
 * Flowise's agentflow prediction response (`executeAgentFlow` return) includes
 * `executionId` + `agentFlowExecutedData` — the per-node trace array Flowise
 * appends as the DAG runs (`IAgentflowExecutedData` = `{ nodeId, nodeLabel,
 * data, previousNodeIds, status }`). So after a run's prediction completes, the
 * scheduler has the full node trace IN the response — no extra Flowise fetch and
 * no run↔execution correlation ambiguity (the response is the run's own).
 *
 * ## Lifecycle
 *
 * Best-effort: a failure logs + returns 0, never throws — called from the
 * run-completion path where a span-write failure must not re-fail the run
 * (node-level trace is an observability projection, not a run-lifecycle
 * concern; same posture as the M6.6 audit hook + M4.2 archive hook).
 */

const log = createLogger({ svc: 'scheduler:node-spans' })

/**
 * Read the `agentFlowExecutedData` + `executionId` out of a Flowise prediction
 * response. Returns `null` when the response isn't an agentflow trace (e.g. a
 * non-agentflow flow, or a Flowise that doesn't surface the field) — the caller
 * then skips ingest.
 *
 * The array arrives already-parsed in the prediction response (the scheduler's
 * `PredictionResult.output` is `await res.json()`). We do NOT JSON.parse here:
 * a string-valued `executionData` (Flowise's DB shape, where the array is
 * JSON-stringified) would not be an array and is silently skipped — the
 * prediction-response path never sees that shape, so the comment that suggested
 * "may be a JSON string" was misleading and is removed.
 */
export function readAgentflowTrace(
  output: unknown,
): { executionId: string | null; agentFlowExecutedData: unknown } | null {
  if (!output || typeof output !== 'object') return null
  const obj = output as Record<string, unknown>
  const data = obj.agentFlowExecutedData ?? obj.executionData
  if (data === undefined) return null
  const executionId =
    typeof obj.executionId === 'string' ? obj.executionId : null
  return { executionId, agentFlowExecutedData: data }
}

/**
 * Ingest node spans for a run from its prediction response (M6.4).
 *
 * Extracts the agentflow node trace from the prediction output, projects it
 * into spans, and persists them. No-op when the output carries no
 * `agentFlowExecutedData` (a non-agentflow run, or a Flowise that doesn't
 * surface the field). Best-effort: a failure logs + returns 0, never throws.
 *
 * `traceId` defaults to the active OTel span's traceId (`currentTraceId()`) so
 * the M6.1↔M6.4 end-to-end trace correlation is wired without each caller
 * threading it explicitly; pass `null` to force-absent, or a value to override.
 * `finishedAt` is stamped from the run's completion time (the caller has it)
 * since the projection is pure and Flowise records no per-node timestamps.
 */
export async function ingestRunNodeSpans(args: {
  runId: string
  flowId: string
  output: unknown
  traceId?: string | null
  finishedAt?: Date | null
}): Promise<number> {
  const trace = readAgentflowTrace(args.output)
  if (!trace) {
    log.debug('prediction output has no agentflow trace; skipping node spans', {
      runId: args.runId,
    })
    return 0
  }
  // M6.1↔M6.4 trace correlation: default to the active span's traceId. The
  // caller runs inside `context.with(trace.setSpan(...))` (worker runTask /
  // fanout runChild), so `currentTraceId()` resolves the run's trace. An
  // explicit `null`/value overrides (tests pass `null` to stay deterministic).
  const traceId = args.traceId !== undefined ? args.traceId : currentTraceId() ?? null
  const spans: NodeSpanInput[] = projectNodeSpans({
    runId: args.runId,
    flowId: args.flowId,
    executionId: trace.executionId,
    agentFlowExecutedData: trace.agentFlowExecutedData,
    traceId,
    finishedAt: args.finishedAt ?? null,
  })
  if (spans.length === 0) return 0
  return writeRunNodeSpans(spans)
}

/**
 * Best-effort node-span ingest (M6.4): never throws, logs on failure. Shared by
 * the worker (single-run) and fan-out (per-child) completion paths so the
 * posture + traceId/finishedAt wiring lives in one place, not duplicated.
 *
 * `traceId` defaults to the active span's traceId (the caller runs inside the
 * M6.1 run-entry span); `finishedAt` defaults to now — both overridable. A span
 * write failure logs a warn and never re-fails the already-completed run (node
 * trace is an observability projection, not a run-lifecycle concern; same
 * posture as the M4.2 archive / M6.6 audit hooks).
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
