import { createLogger } from '@dagents/shared'

/**
 * Client for the Prediction API, reached through the gateway.
 *
 * The gateway exposes prediction endpoints that delegate to the workflow engine.
 * This module defines the shared `PredictionClient` interface used across the
 * scheduler (fan-out, worker, rerun, reproduce), so different backend
 * implementations can be swapped in without changes to core scheduling logic.
 *
 * Why an interface: the scheduler's fan-out test needs to assert the N→N child
 * mapping and parent aggregation without a live backend. Injecting a
 * `PredictionClient` lets the test swap in a stub that records calls and
 * returns canned output; the real implementation is wired in `index.ts` for
 * production.
 */

/** A single prediction request — one run's input. */
export interface PredictionRequest {
  /** Workflow / pipeline id. */
  flowId: string
  /** Per-input body. */
  body: unknown
}

/** Normalized prediction outcome. `output` is the raw JSON response. */
export interface PredictionResult {
  /** The run id this result corresponds to (echoed for correlation). */
  runId: string
  /** Response body (already-parsed JSON, or a wrapped fallback). */
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

export interface PredictionClientOpts {
  /** Gateway base URL, e.g. http://localhost:8080. */
  gatewayUrl: string
  /** Optional Authorization header forwarded to the gateway (caller's token). */
  authorization?: string
}

/**
 * Build a prediction request with the standard gateway-facing shape. Shared
 * helper so all client implementations POST consistently: JSON body, `x-run-id`
 * header for end-to-end correlation, and best-effort error / response parsing.
 *
 * Returns the normalized `PredictionResult`. Throws `PredictionError` on
 * non-2xx or transport failure.
 */
export async function postPrediction(
  opts: PredictionClientOpts,
  urlPath: string,
  req: PredictionRequest,
  runId: string,
  logSvc: string,
): Promise<PredictionResult> {
  const gatewayUrl = opts.gatewayUrl.replace(/\/$/, '')
  const log = createLogger({ svc: logSvc })

  const url = `${gatewayUrl}${urlPath}`
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
    log.error('prediction transport failure', { runId, flowId: req.flowId, error: String(err) })
    throw new PredictionError(runId, 502, `prediction transport failure: ${String(err)}`)
  }

  const durationMs = Date.now() - start

  if (!res.ok) {
    log.warn('prediction non-2xx', { runId, flowId: req.flowId, status: res.status })
    throw new PredictionError(runId, res.status, `prediction failed: ${res.status}`)
  }

  const clone = res.clone()
  let output: unknown
  try {
    output = await res.json()
  } catch {
    output = { raw: await clone.text() }
  }

  return { runId, output, durationMs }
}
