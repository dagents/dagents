/**
 * Console → gateway node-spans proxy.
 *
 * After the scheduler merge (Plan A 2026-08-01), the gateway owns both the
 * write path (`POST /api/v1/workflows/:id/run` writes `run_node_spans`) and
 * the read path (`GET /api/v1/workflows/runs/:runId/node-spans`). The browser
 * never talks to the gateway directly: it calls this Next API route, which
 * keeps the gateway URL server-side.
 *
 * Read-only (GET). 4xx from the gateway is forwarded verbatim so the caller
 * can distinguish "bad run id" / "no such run" from "gateway down"; 5xx
 * collapses to a sanitized 502.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'

function jsonHeaders(upstream: Response): Headers {
  const h = new Headers()
  h.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
  return h
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const upstreamUrl = `${gatewayUrl()}/api/v1/workflows/runs/${encodeURIComponent(runId)}/node-spans${req.nextUrl.search}`
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

  if (upstream.ok) {
    const body = await upstream.text()
    return new NextResponse(body, { status: 200, headers: jsonHeaders(upstream) })
  }

  // Forward 4xx (400 invalid runId / 404 no such run) verbatim; collapse 5xx.
  if (upstream.status >= 500) {
    return NextResponse.json(
      { success: false, error: 'upstream error', upstreamStatus: upstream.status },
      { status: 502 },
    )
  }
  const detail = await upstream.text().catch(() => '')
  return NextResponse.json(
    { success: false, error: 'node-spans failed', status: upstream.status, detail: detail.slice(0, 500) },
    { status: upstream.status },
  )
}
