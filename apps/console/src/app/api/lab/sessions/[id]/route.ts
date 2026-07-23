/**
 * `GET /api/lab/sessions/[id]` + `PATCH /api/lab/sessions/[id]` — one Lab
 * session's detail (GET) + mode/status update (PATCH) proxy (M5b.2 / P1.10.T7).
 *
 * GET forwards to the gateway's `GET /api/v1/lab/sessions/:id` (session row +
 * its most-recent 200 messages, oldest-first).
 * PATCH forwards to the gateway's `PATCH /api/v1/lab/sessions/:id` — the chat
 * header's auto/assist mode toggle + the "归档会话" button (status → done) both
 * go through here. The gateway URL stays server-side.
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  // Forward the path segment verbatim; the gateway validates the UUID shape
  // (400 on malformed, 404 on missing). Encoding here is defensive against a
  // stray `/` in the segment.
  let upstream: Response
  try {
    upstream = await fetch(
      buildLabUpstreamUrl(`/sessions/${encodeURIComponent(id)}`, req.nextUrl.search),
      { method: 'GET', headers: forwardLabHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    labLogProxyError('session-detail', err)
    return labFail(502, 'gateway unavailable')
  }
  return pipeLabUpstream(upstream)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(buildLabUpstreamUrl(`/sessions/${encodeURIComponent(id)}`, ''), {
      method: 'PATCH',
      headers: forwardLabHeaders(req, 'application/json'),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    labLogProxyError('session-patch', err)
    return labFail(502, 'gateway unavailable')
  }
  return pipeLabUpstream(upstream)
}
