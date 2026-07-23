/**
 * Server-side Flowise fetch helpers for the console flow routes (P1.10.T5).
 *
 * The browser hits the console's own `/api/flows/*` routes (in this folder),
 * which fetch the gateway's read-only Flowise passthrough
 * (`/api/v1/chatflows`, `/api/v1/executions` — see `apps/gateway/src/app.ts`
 * `proxyFlowiseRead`). The Flowise API key stays server-side (the gateway holds
 * it), and these helpers centralize the fetch + non-2xx handling so the three
 * route handlers stay small.
 *
 * The gateway collapses every Flowise non-2xx to a sanitized 502, so the only
 * failure status we see here is 502 (plus 503 when the key isn't configured).
 * Both are surfaced to the route as a thrown `FlowiseFetchError` carrying the
 * status; the route maps that to a client-visible envelope.
 *
 * M5b.4: `x-run-id` is generated per fetch (the flows read routes are
 * server-rendered, so there's no browser page id to reuse) and forwarded so the
 * gateway's read passthrough is traceable. The gateway's `proxyFlowiseRead`
 * forwards a caller `x-run-id` like any non-hop-by-hop header, so it lands in
 * the gateway log + OTel context for that hop. The SSO session cookie is also
 * forwarded: `/api/v1/chatflows` is a non-public route under `REQUIRE_LOGIN=1`,
 * so without the cookie the Flows browse page 401s for logged-in users. The
 * flows routes thread their inbound `NextRequest` so the same caller identity
 * flows through; the request is optional only for callers that intentionally
 * want no cookie (none today).
 */

import { type NextRequest } from 'next/server'
import { gatewayUrl } from './config'
import { resolveRunId } from './run-id'

export class FlowiseFetchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FlowiseFetchError'
  }
}

/**
 * Fetch JSON from a gateway-proxied Flowise read endpoint. Throws on non-2xx.
 *
 * `req` (when passed) threads the caller's SSO session cookie so the gateway's
 * session middleware sees the caller under `REQUIRE_LOGIN=1`. The flows read
 * routes are server-rendered and pass their inbound `NextRequest`; callers
 * without a request forward no cookie and rely on the open dev posture.
 */
export async function fetchFlowiseJson<T>(
  path: string,
  req?: NextRequest,
): Promise<T> {
  const url = `${gatewayUrl()}${path}`
  const headers: Record<string, string> = {
    accept: 'application/json',
    // M5b.4: always carry an x-run-id (generated) so the gateway read hop
    // is traceable even though the browser didn't send one for a read.
    'x-run-id': resolveRunId(req?.headers.get('x-run-id')),
  }
  if (req) {
    const cookie = req.headers.get('cookie')
    if (cookie) headers['cookie'] = cookie
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
    })
  } catch (err) {
    throw new FlowiseFetchError(502, `flowise unreachable: ${String(err)}`)
  }

  if (!res.ok) {
    // The gateway already sanitized the body; read a short detail for logging.
    const detail = await res.text().catch(() => '')
    throw new FlowiseFetchError(
      res.status,
      `flowise ${path} failed (${res.status})${detail ? `: ${detail.slice(0, 120)}` : ''}`,
    )
  }

  try {
    return (await res.json()) as T
  } catch (err) {
    throw new FlowiseFetchError(502, `flowise ${path} returned non-JSON: ${String(err)}`)
  }
}
