/**
 * Console → gateway node-spans proxy.
 *
 * Primary upstream is the scheduler proxy
 * (`/api/v1/scheduler/runs/:runId/node-spans`) for fan-out runs produced by
 * the scheduler. When that upstream returns 404 (run produced by the gateway
 * itself, not the scheduler), we fall back to the gateway's own node-spans
 * route (`/api/v1/workflows/runs/:runId/node-spans`) which serves the
 * `run_node_spans` rows the gateway wrote in `POST /:id/run`.
 *
 * The browser never talks to the gateway directly: it calls this route, which
 * keeps the gateway URL + the scheduler's row shape server-side.
 *
 * Read-only (GET). 4xx from the gateway/scheduler is forwarded verbatim so
 * the caller can distinguish "bad run id" / "no such run" from "gateway
 * down"; 5xx collapses to a sanitized 502.
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
  const schedulerUpstreamUrl = `${gatewayUrl()}/api/v1/scheduler/runs/${encodeURIComponent(runId)}/node-spans${req.nextUrl.search}`
  const gatewayFallbackUrl = `${gatewayUrl()}/api/v1/workflows/runs/${encodeURIComponent(runId)}/node-spans${req.nextUrl.search}`

  const headers = forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')))

  // ── 1. Try the scheduler proxy first (fan-out runs live there) ──────────
  let scheduler: Response
  try {
    scheduler = await fetch(schedulerUpstreamUrl, { method: 'GET', cache: 'no-store', headers })
  } catch (err) {
    // Gateway unavailable — try the fallback before bailing out entirely.
    return fetch(gatewayFallbackUrl, { method: 'GET', cache: 'no-store', headers })
      .then(async (fallback) => {
        if (fallback.ok) {
          const body = await fallback.text()
          return new NextResponse(body, { status: 200, headers: jsonHeaders(fallback) })
        }
        return NextResponse.json(
          { success: false, error: 'gateway unavailable', detail: String(err) },
          { status: 502 },
        )
      })
      .catch(() =>
        NextResponse.json(
          { success: false, error: 'gateway unavailable', detail: String(err) },
          { status: 502 },
        ),
      )
  }

  if (scheduler.ok) {
    const body = await scheduler.text()
    return new NextResponse(body, { status: 200, headers: jsonHeaders(scheduler) })
  }

  if (scheduler.status === 404) {
    // ── 2. Scheduler has no record → gateway's own span store fallback ──
    const detail = await scheduler.text().catch(() => '')
    let fallback: Response
    try {
      fallback = await fetch(gatewayFallbackUrl, { method: 'GET', cache: 'no-store', headers })
    } catch (err) {
      return NextResponse.json(
        { success: false, error: 'node-spans failed', status: 404, schedulerDetail: detail.slice(0, 500), fallbackDetail: String(err) },
        { status: 404 },
      )
    }
    if (fallback.ok) {
      const body = await fallback.text()
      return new NextResponse(body, { status: 200, headers: jsonHeaders(fallback) })
    }
    // Both upstreams failed — report the 404 (the canonical outcome: this
    // run id genuinely has no spans).
    const fallbackBody = await fallback.text().catch(() => '')
    return NextResponse.json(
      {
        success: false,
        error: 'node-spans failed',
        status: 404,
        schedulerDetail: detail.slice(0, 500),
        fallbackDetail: fallbackBody.slice(0, 500),
      },
      { status: 404 },
    )
  }

  // Any other non-2xx from the scheduler is forwarded verbatim.
  const detail = await scheduler.text().catch(() => '')
  return NextResponse.json(
    { success: false, error: 'node-spans failed', status: scheduler.status, detail: detail.slice(0, 500) },
    { status: scheduler.status },
  )
}
