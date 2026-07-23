/**
 * Console → gateway agent-logs proxy (M5a.2 / P1.10.T4).
 *
 * Forwards `GET /api/agents/:id/logs` to
 * `${gatewayUrl()}/api/v1/dispatch/agents/:id/logs` (dispatch log stream
 * route). Returns the mapped `{ logs: [{ ts, level, msg }] }` envelope for the
 * drawer's `.log` section.
 *
 * M5b.4: `x-run-id` is always forwarded (generated if absent) and the SSO
 * session cookie is threaded through, via the shared `forwardSessionHeaders`.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/dispatch/agents/${encodeURIComponent(id)}/logs`

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

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'agent logs failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
