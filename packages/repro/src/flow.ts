import { createLogger } from '@mil/shared'

/**
 * Fetches the Flowise flow JSON for a flow id (plan M4.1 P1.8.T1).
 *
 * Flowise serves a flow's definition at `GET /api/v1/chatflows/:id`. The gateway
 * is the single upstream surface for the platform (it owns auth + the only
 * forwarded Flowise route in MVP is `<id>/prediction`; `snapshotPipeline` calls
 * the flow-definition endpoint directly on Flowise through the gateway as a
 * plain passthrough, matching how `prediction-client.ts` reaches
 * `/api/v1/prediction/:id` via the gateway). The endpoint is injected so tests
 * can stub it without a live Flowise — same seam the scheduler's
 * `PredictionClient` uses.
 *
 * `gatewayUrl` may be set lazily (via a function) so tests can repoint it via
 * `process.env` at runtime, mirroring `flowiseUrl()` in `apps/gateway/src/app.ts`.
 */

const log = createLogger({ svc: 'repro:flow' })

export interface FetchFlowOpts {
  /** Gateway base URL, e.g. http://localhost:8080. */
  gatewayUrl: string
  /** Optional Authorization header forwarded to the gateway (caller's token). */
  authorization?: string
}

/** A fetched flow definition — `flowJson` is Flowise's full chatflow row JSON. */
export interface FetchedFlow {
  flowId: string
  flowJson: unknown
}

export class FlowFetchError extends Error {
  constructor(
    public flowId: string,
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FlowFetchError'
  }
}

/**
 * Fetch the flow definition JSON from Flowise (through the gateway) and return
 * it. Resolves on 2xx, rejects with `FlowFetchError` otherwise. The response
 * body is Flowise's chatflow row; we pass it through verbatim as `unknown` —
 * `snapshotPipeline` re-serializes it canonically before hashing, so its raw
 * shape is opaque to this layer.
 */
export async function fetchFlowJson(
  flowId: string,
  opts: FetchFlowOpts,
): Promise<FetchedFlow> {
  const base = opts.gatewayUrl.replace(/\/$/, '')
  const url = `${base}/api/v1/chatflows/${encodeURIComponent(flowId)}`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.authorization) headers.authorization = opts.authorization

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    // Network / DNS / connection refused — gateway unreachable. Treat as a
    // 502-shaped failure so the caller can surface a transport reason rather
    // than crashing (mirrors prediction-client.ts).
    log.error('flow fetch transport failure', { flowId, error: String(err) })
    throw new FlowFetchError(flowId, 502, `flow fetch transport failure: ${String(err)}`)
  }

  if (!res.ok) {
    // A 4xx is the caller's fault (bad flowId / auth); a 5xx is upstream. The
    // body is intentionally not surfaced verbatim — Flowise error bodies can
    // carry stacks / internal hostnames (same rationale as the gateway proxy).
    log.warn('flow fetch non-2xx', { flowId, status: res.status })
    throw new FlowFetchError(flowId, res.status, `flow fetch failed: ${res.status}`)
  }

  // Clone before parsing so a successful non-JSON body (plain text) can fall
  // back without the "body already read" throw undici enforces (verified in
  // prediction-client.ts). If JSON parses, the clone is discarded.
  const clone = res.clone()
  let flowJson: unknown
  try {
    flowJson = await res.json()
  } catch {
    // Non-JSON body — wrap so the snapshot stays JSONB-shaped downstream.
    flowJson = { raw: await clone.text() }
  }

  return { flowId, flowJson }
}
