/**
 * Console → gateway daemons-list proxy.
 *
 * The create-agent dialog needs to enumerate registered daemons so the user can
 * pick which daemon hosts the new agent. This route forwards to the gateway's
 * dispatch passthrough (`${gatewayUrl()}/api/v1/dispatch/daemons`), which calls
 * the dispatch server's GET /daemons. Server-side proxy keeps the gateway URL
 * private and threads the SSO session cookie through.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const upstreamUrl = `${gatewayUrl()}/api/v1/dispatch/daemons`
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
      { success: false, error: 'daemons list failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
