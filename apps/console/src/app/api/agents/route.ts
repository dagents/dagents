/**
 * Console → gateway agents-list proxy (M5a.2 / P1.10.T4).
 *
 * The browser agents view GETs `/api/agents`; this route forwards to the
 * gateway's blind dispatch passthrough
 * (`${gatewayUrl()}/api/v1/dispatch/agents`), which forwards verbatim to the
 * dispatch server's `GET /agents` (apps/dispatch/src/routes/agents.ts). Keeping
 * the gateway URL server-side matches the chat proxy's posture (see
 * api/chat/route.ts): no CORS, no origin leak, one consistent proxy layer.
 *
 * Query params (`kind`/`status`/`role`/`region`/`q`) are forwarded as-is even
 * though the dispatch route currently filters client-side — the gateway passes
 * them through, and a future server-side filter can consume them without a
 * console change. `x-run-id` is always threaded through (M5b.4: generated if
 * the caller omitted one, so every hop is traceable), and the SSO session
 * cookie is forwarded so the gateway's session middleware sees the caller.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const upstreamUrl = `${gatewayUrl()}/api/v1/dispatch/agents${req.nextUrl.search}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  // Forward the dispatch JSON envelope verbatim. The gateway collapses
  // upstream non-2xx to 502; pass the status + (truncated) body through so the
  // view can surface the reason.
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'agents list failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
