/**
 * Console → gateway agents-list proxy (M5a.2 / P1.10.T4).
 *
 * The browser agents view GETs `/api/agents`; this route forwards to the
 * gateway's unified agents route
 * (`${gatewayUrl()}/api/v1/agents`), which queries the `agents` table (LEFT
 * JOIN agent_daemons + daemons + dispatch_tasks) and returns a design-aligned
 * DTO. Keeping the gateway URL server-side matches the chat proxy's posture
 * (see api/chat/route.ts): no CORS, no origin leak, one consistent proxy layer.
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
  const upstreamUrl = `${gatewayUrl()}/api/v1/agents${req.nextUrl.search}`

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

/**
 * POST /api/agents — proxy agent creation to the gateway.
 *
 * Forwards the JSON body verbatim to `${gatewayUrl()}/api/v1/agents`,
 * which the gateway's POST handler validates (zod) + inserts into the
 * `agents` table. The response carries the new agent's id in
 * `{ success, data: { id } }`.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const upstreamUrl = `${gatewayUrl()}/api/v1/agents`
  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')), true)

  let body: string
  try {
    body = JSON.stringify(await req.json())
  } catch {
    return NextResponse.json(
      { success: false, error: 'invalid JSON body' },
      { status: 400 },
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: 'POST', headers, body })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
