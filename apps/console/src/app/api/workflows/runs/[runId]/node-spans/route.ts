/**
 * Console → gateway scheduler node-spans proxy.
 *
 * Forwards `GET /api/workflows/runs/:runId/node-spans` to the gateway's
 * `/api/v1/scheduler/runs/:runId/node-spans` passthrough (which in turn dials
 * the scheduler). The browser never talks to the gateway directly: it calls
 * this route, which keeps the gateway URL + the scheduler's row shape
 * server-side.
 *
 * Read-only (GET). A non-GET hits the gateway's own 405 (the gateway enforces
 * GET-only on the scheduler passthrough). 4xx from the gateway/scheduler is
 * forwarded verbatim so the caller can distinguish "bad run id" / "no such
 * run" from "gateway down"; 5xx collapses to a sanitized 502.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/scheduler/runs/${encodeURIComponent(runId)}/node-spans${req.nextUrl.search}`

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
      { success: false, error: 'node-spans failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
