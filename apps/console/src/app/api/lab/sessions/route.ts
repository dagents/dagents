/**
 * `GET /api/lab/sessions` + `POST /api/lab/sessions` — Lab session list +
 * create proxy (M5b.2 / P1.10.T7).
 *
 * The browser Lab view GETs this route for the left session list and POSTs to
 * create a new experiment; both forward to the gateway's
 * `/api/v1/lab/sessions` API (`apps/gateway/src/routes/lab.ts`). The gateway
 * URL stays server-side (no CORS, no origin leak) — same posture as the
 * `/api/workspaces` proxy.
 *
 * `GET` query params (`status`, `workspaceId`, `limit`) are forwarded as-is;
 * the gateway validates + clamps them. `x-run-id` is threaded through for
 * trace correlation. `POST` forwards the JSON body the gateway validates.
 */

import { type NextRequest } from 'next/server'
import {
  buildLabUpstreamUrl,
  forwardLabHeaders,
  labFail,
  labLogProxyError,
  pipeLabUpstream,
} from '@/lib/lab-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/lab/sessions — list. Forwards the gateway's session list verbatim. */
export async function GET(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildLabUpstreamUrl('/sessions', req.nextUrl.search), {
      method: 'GET',
      headers: forwardLabHeaders(req),
      cache: 'no-store',
    })
  } catch (err) {
    labLogProxyError('sessions-list', err)
    return labFail(502, 'gateway unavailable')
  }
  return pipeLabUpstream(upstream)
}

/** POST /api/lab/sessions — create. Forwards the gateway's created session verbatim. */
export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(buildLabUpstreamUrl('/sessions', ''), {
      method: 'POST',
      headers: forwardLabHeaders(req, 'application/json'),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    labLogProxyError('sessions-create', err)
    return labFail(502, 'gateway unavailable')
  }
  return pipeLabUpstream(upstream)
}
