/**
 * `GET /api/lab/sessions/[id]/messages` + `POST /api/lab/sessions/[id]/messages`
 * — Lab thread page + append proxy (M5b.2 / P1.10.T7).
 *
 * `GET` forwards to the gateway's
 * `GET /api/v1/lab/sessions/:id/messages` (paginated thread, for scroll-back).
 * `POST` forwards to the gateway's append route — the console composer posts a
 * `human` turn (an intervention); an agent write path posts an agent turn with
 * `agentId` / `thinking` / `toolCall`. The caller's `x-run-id` threads into
 * the new `lab_messages` row so the turn is end-to-end traceable. The gateway
 * URL stays server-side.
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
  let upstream: Response
  try {
    upstream = await fetch(
      buildLabUpstreamUrl(`/sessions/${encodeURIComponent(id)}/messages`, req.nextUrl.search),
      { method: 'GET', headers: forwardLabHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    labLogProxyError('messages-list', err)
    return labFail(502, 'gateway unavailable')
  }
  return pipeLabUpstream(upstream)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(
      buildLabUpstreamUrl(`/sessions/${encodeURIComponent(id)}/messages`, ''),
      {
        method: 'POST',
        headers: forwardLabHeaders(req, 'application/json'),
        body,
        cache: 'no-store',
      },
    )
  } catch (err) {
    labLogProxyError('messages-append', err)
    return labFail(502, 'gateway unavailable')
  }
  return pipeLabUpstream(upstream)
}
