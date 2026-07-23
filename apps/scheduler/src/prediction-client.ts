import { createLogger } from '@mil/shared'

/**
 * Client for the Flowise Prediction API, reached through the gateway
 * (plan M3.1; spec §1.7 — "调 Flowise POST /api/v1/prediction/{flowId}（经
 * gateway）").
 *
 * The gateway rewrites `/api/v1/flows/<flowId>/prediction` → Flowise's
 * `/api/v1/prediction/<flowId>` and threads an `x-run-id` end-to-end (see
 * `apps/gateway/src/app.ts`). So this client posts to the gateway's path
 * shape, not Flowise's, and lets the gateway own the rewrite + run-id
 * correlation. Every child run in a fan-out posts with its own `x-run-id` so
 * traces/logs can be correlated back to the child `runs` row.
 *
 * Why an interface: the scheduler's fan-out test (M3.2) needs to assert the
 * N→N child mapping and parent aggregation without a live Flowise. Injecting a
 * `PredictionClient` lets the test swap in a stub that records calls and
 * returns canned output; the real `FlowisePredictionClient` is wired in
 * `index.ts` for production.
 *
 * `overrideConfig.sessionId` carries the child run id into Flowise (architecture
 * v0.2 §6.5: "body: { 单篇输入, overrideConfig: {sessionId: 子run_id} }") so a
 * resumed session lands on the right Flow State — this is the seam M3.3 later
 * verifies across instances.
 */

/** A single prediction request — one child run's input. */
export interface PredictionRequest {
  /** Flowise chatflow / flow id. */
  flowId: string
  /** Per-input body. `overrideConfig.sessionId` should be the child run id. */
  body: unknown
}

/** Normalized prediction outcome. `output` is Flowise's raw JSON response. */
export interface PredictionResult {
  /** The run id this result corresponds to (echoed for correlation). */
  runId: string
  /** Flowise response body (already-parsed JSON, or a wrapped fallback). */
  output: unknown
  /** Wall-clock duration of the upstream call, for `runs.duration_ms`. */
  durationMs: number
}

/**
 * Raised when the gateway returns a non-2xx. Carries the status so the fan-out
 * layer can mark the child run `failed` with a structured reason rather than a
 * bare string.
 */
export class PredictionError extends Error {
  constructor(
    public runId: string,
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PredictionError'
  }
}

export interface PredictionClient {
  /** Execute one prediction. Resolves on 2xx, rejects with PredictionError otherwise. */
  predict(req: PredictionRequest, runId: string): Promise<PredictionResult>
}

export interface FlowisePredictionClientOpts {
  /** Gateway base URL, e.g. http://localhost:8080. */
  gatewayUrl: string
  /** Optional Authorization header forwarded to the gateway (caller's token). */
  authorization?: string
}

/** Production client: POSTs to the gateway's rewriting proxy. */
export function createFlowisePredictionClient(
  opts: FlowisePredictionClientOpts,
): PredictionClient {
  const gatewayUrl = opts.gatewayUrl.replace(/\/$/, '')
  const log = createLogger({ svc: 'scheduler:prediction' })

  return {
    predict: async (req, runId) => {
      const url = `${gatewayUrl}/api/v1/flows/${encodeURIComponent(req.flowId)}/prediction`
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-run-id': runId,
      }
      if (opts.authorization) headers.authorization = opts.authorization

      const start = Date.now()
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body ?? {}),
        })
      } catch (err) {
        // Network / DNS / connection refused — the gateway is unreachable.
        // Treat as a 502-shaped failure so the child run is marked failed with
        // a transport reason rather than crashing the fan-out loop.
        log.error('prediction transport failure', { runId, flowId: req.flowId, error: String(err) })
        throw new PredictionError(runId, 502, `prediction transport failure: ${String(err)}`)
      }

      const durationMs = Date.now() - start

      if (!res.ok) {
        // Gateway collapses upstream 5xx to a sanitized 502 (see gateway app.ts);
        // a 4xx is the caller's fault (bad flowId / body). Either way the child
        // run fails — the body is intentionally not surfaced verbatim because
        // upstream error bodies can carry stacks / internal hostnames.
        log.warn('prediction non-2xx', { runId, flowId: req.flowId, status: res.status })
        throw new PredictionError(runId, res.status, `prediction failed: ${res.status}`)
      }

      // The Response body is single-use: `res.json()` consumes it, and a later
      // `res.text()` throws "body already read" (verified — undici enforces
      // this). A successful non-JSON body (e.g. plain text) would then throw
      // out of the catch and wrongly fail the child run. Clone *before*
      // parsing so the fallback can still read the original bytes; if JSON
      // parses, the clone is just discarded.
      const clone = res.clone()
      let output: unknown
      try {
        output = await res.json()
      } catch {
        // Non-JSON success body (e.g. plain text). Wrap so `runs.output` stays
        // JSONB-shaped; downstream aggregation treats it as an opaque blob.
        output = { raw: await clone.text() }
      }

      return { runId, output, durationMs }
    },
  }
}
