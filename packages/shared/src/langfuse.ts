/**
 * Langfuse trace export — the v2-compatible ingestion client.
 *
 * ## Why not OTLP?
 *
 * The dev stack pins Langfuse to v2.95.11 (see infra/docker-compose.yml),
 * and v2 does NOT expose OTLP ingestion (`/api/public/otel*` returns 404) —
 * OTLP is a v3 feature requiring ClickHouse. So `packages/shared/src/otel.ts`
 * handles propagation only, and THIS module lands traces through the one
 * v2-native path that works: the batched ingestion REST API
 * (`POST /api/public/ingestion`) every Langfuse 2.x/3.x SDK uses.
 *
 * ## Activation
 *
 * Env-driven, off by default (tests and collector-less dev stay clean):
 *
 *   LANGFUSE_BASE_URL=http://localhost:3001
 *   LANGFUSE_PUBLIC_KEY=pk-lf-...   # provision in the Langfuse UI → Settings → API Keys
 *   LANGFUSE_SECRET_KEY=sk-lf-...
 *
 * All three must be set; otherwise `exportRunTraceToLangfuse` no-ops and
 * reports `{ exported: false }`.
 *
 * ## Shape
 *
 * One batch per workflow run: a `trace-create` event (id = runId, sessionId
 * = chatId) plus one `generation-create` per LLM-calling node and one
 * `span-create` per other node, mapping the executor's executed-node records
 * onto Langfuse's observation model. The caller can persist the trace id
 * (== runId) onto `run_node_spans.trace_id` for correlation.
 */

/** Minimal executed-node shape — matches @dagents/workflow's IExecutedNode. */
export interface LangfuseNodeRecord {
  nodeId: string
  nodeName: string
  startedAt: string
  endedAt: string
  status: string
  input?: Record<string, unknown> | null
  output?: Record<string, unknown> | null
  error?: string | null
  tokens?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
}

/** Input for `exportRunTraceToLangfuse`. */
export interface RunTraceInput {
  runId: string
  flowId: string
  flowName: string
  chatId?: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt: string
  input?: unknown
  output?: unknown
  nodes: LangfuseNodeRecord[]
}

/** Result of an export attempt. */
export interface RunTraceExportResult {
  exported: boolean
  traceId?: string
  error?: string
}

/** Node type names that represent an LLM call (exported as generations). */
const LLM_NODE_NAMES = new Set([
  'llmAgentflow',
  'agentAgentflow',
  'platformAgentAgentflow',
  'conditionAgentAgentflow',
])

const INGEST_TIMEOUT_MS = 8_000

/** Whether Langfuse credentials are fully configured. */
export function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_BASE_URL &&
      process.env.LANGFUSE_PUBLIC_KEY &&
      process.env.LANGFUSE_SECRET_KEY,
  )
}

/**
 * Export one workflow run to Langfuse. No-op (not an error) when unconfigured;
 * network/API failures are returned as `{ exported: false, error }` so the
 * caller can log without failing the run.
 */
export async function exportRunTraceToLangfuse(
  run: RunTraceInput,
): Promise<RunTraceExportResult> {
  if (!isLangfuseConfigured()) {
    return { exported: false }
  }

  const baseUrl = process.env.LANGFUSE_BASE_URL!.replace(/\/+$/, '')
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString('base64')

  const now = new Date().toISOString()
  const batch: Array<Record<string, unknown>> = [
    {
      id: crypto.randomUUID(),
      type: 'trace-create',
      timestamp: now,
      body: {
        id: run.runId,
        name: run.flowName,
        timestamp: run.startedAt,
        sessionId: run.chatId,
        metadata: { flowId: run.flowId, runId: run.runId, status: run.status },
        input: sanitize(run.input),
        output: sanitize(run.output),
      },
    },
  ]

  for (const node of run.nodes) {
    const observationId = `${run.runId}-${node.nodeId}`
    const base = {
      id: observationId,
      traceId: run.runId,
      name: node.nodeName,
      startTime: node.startedAt,
      endTime: node.endedAt,
      metadata: { nodeId: node.nodeId, status: node.status },
      input: sanitize(node.input),
      output: sanitize(node.output ?? (node.error ? { error: node.error } : null)),
    }

    if (LLM_NODE_NAMES.has(node.nodeName)) {
      batch.push({
        id: crypto.randomUUID(),
        type: 'generation-create',
        timestamp: now,
        body: {
          ...base,
          model: readModel(node.input),
          usage: node.tokens
            ? {
                promptTokens: node.tokens.prompt_tokens,
                completionTokens: node.tokens.completion_tokens,
                totalTokens: node.tokens.total_tokens,
              }
            : undefined,
        },
      })
    } else {
      batch.push({
        id: crypto.randomUUID(),
        type: 'span-create',
        timestamp: now,
        body: base,
      })
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ batch, metadata: { source: 'dagents-gateway' } }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        exported: false,
        traceId: run.runId,
        error: `Langfuse ingestion ${res.status}: ${text.slice(0, 300)}`,
      }
    }
    return { exported: true, traceId: run.runId }
  } catch (err) {
    return {
      exported: false,
      traceId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Extract the model identifier from a node's recorded input, if present. */
function readModel(input: Record<string, unknown> | null | undefined): string | undefined {
  const model = input?.model
  return typeof model === 'string' && model.length > 0 ? model : undefined
}

/** JSON-safe copy — drops undefined values and truncates huge payloads. */
function sanitize(value: unknown, maxLen = 20_000): unknown {
  if (value === undefined || value === null) return null
  try {
    const json = JSON.stringify(value)
    return json.length > maxLen ? { truncated: json.slice(0, maxLen) } : JSON.parse(json)
  } catch {
    return { unserializable: String(value) }
  }
}
