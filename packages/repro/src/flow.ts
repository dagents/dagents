import { createLogger } from '@dagents/shared'

/**
 * Fetches the workflow definition JSON for a workflow id.
 *
 * The gateway serves workflow definitions at `GET /api/v1/workflows/:id`.
 * The endpoint is injected so tests can stub it without a live workflow engine.
 *
 * `gatewayUrl` may be set lazily (via a function) so tests can repoint it via
 * `process.env` at runtime.
 */

const log = createLogger({ svc: 'repro:flow' })

export interface FetchFlowOpts {
  /** Gateway base URL, e.g. http://localhost:8080. */
  gatewayUrl: string
  /** Optional Authorization header forwarded to the gateway (caller's token). */
  authorization?: string
}

/** A fetched workflow definition — `flowJson` is the workflow's flow_data. */
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
 * Fetch the workflow definition JSON from the gateway and return it.
 * Resolves on 2xx, rejects with `FlowFetchError` otherwise. The response
 * body is the workflow's flow_data; we pass it through verbatim as `unknown` —
 * `snapshotPipeline` re-serializes it canonically before hashing, so its raw
 * shape is opaque to this layer.
 */
export async function fetchFlowJson(
  flowId: string,
  opts: FetchFlowOpts,
): Promise<FetchedFlow> {
  const base = opts.gatewayUrl.replace(/\/$/, '')
  const url = `${base}/api/v1/workflows/${encodeURIComponent(flowId)}`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.authorization) headers.authorization = opts.authorization

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    log.error('flow fetch transport failure', { flowId, error: String(err) })
    throw new FlowFetchError(flowId, 502, `flow fetch transport failure: ${String(err)}`)
  }

  if (!res.ok) {
    log.warn('flow fetch non-2xx', { flowId, status: res.status })
    throw new FlowFetchError(flowId, res.status, `flow fetch failed: ${res.status}`)
  }

  const clone = res.clone()
  let flowJson: unknown
  try {
    const data = await res.json() as Record<string, unknown>
    const dataObj = data.data as Record<string, unknown> | undefined
    const flowObj = dataObj?.flow as Record<string, unknown> | undefined
    flowJson = flowObj?.flowData ?? data
  } catch {
    flowJson = { raw: await clone.text() }
  }

  return { flowId, flowJson }
}
