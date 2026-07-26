import { context, trace } from '@opentelemetry/api'

/**
 * OTel's `Span` API interface only exposes attribute *writers* (setAttribute /
 * setAttributes), not a reader. SDK Span implementations expose `attributes`
 * at runtime, so we assert to this minimal readable shape to read `run.id`
 * back from the active span.
 */
interface ReadableSpan {
  attributes?: Record<string, unknown>
}

export interface TraceContext { runId: string; traceId: string; parentRunId?: string }

export function getTracer(name = 'dagents') {
  return trace.getTracer(name)
}

export function currentRunId(): string | undefined {
  const span = trace.getSpan(context.active()) as ReadableSpan | undefined
  return span?.attributes?.['run.id'] as string | undefined
}

/**
 * Read the W3C traceId of the active span (M6.4 node-level trace correlation).
 *
 * M6.1 threads one OTel traceId across gateway→flowise→daemon→LLM by stamping
 * `run.id` on a run-entry span. M6.4 persists that traceId on each
 * `run_node_spans` row so the AgentFlows inspector can link a node to the
 * service-level trace. `runId ≠ traceId` — the runId is the platform's
 * `runs.id`; the traceId is the OTel span context's 32-hex id. This reads the
 * active span's `spanContext().traceId`, returning `undefined` when no span is
 * active (e.g. outside a `context.with(trace.setSpan(...))` block — then the
 * caller leaves the column null).
 */
export function currentTraceId(): string | undefined {
  const span = trace.getSpan(context.active())
  return span?.spanContext().traceId
}
