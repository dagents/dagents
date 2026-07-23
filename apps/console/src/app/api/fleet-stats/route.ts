/**
 * Console → gateway fleet-stats proxy (M6.3 / P1.11.T4).
 *
 * The dashboard view GETs `/api/fleet-stats`; this route forwards to the
 * gateway's blind dispatch passthrough
 * (`${gatewayUrl()}/api/v1/dispatch/fleet-stats`), which forwards verbatim to
 * the dispatch server's `GET /fleet-stats` (apps/dispatch/src/routes/fleet-stats.ts,
 * the M6.5 aggregation API). Same posture as `api/agents/route.ts`: the gateway
 * URL stays server-side (no CORS, no origin leak), and upstream non-2xx is
 * collapsed by the gateway to a sanitized 502 that the view surfaces.
 *
 * The window query param sizes the throughput/cost window. The M8.1 redesign
 * sends the design's preset token as `?window=1h|24h|7d`; this proxy resolves
 * it to the numeric `windowHours` the dispatch server consumes (clamped to
 * 1–168) and forwards that upstream. A bare `?windowHours=N` is still honored
 * for back-compat with any direct numeric caller. M5b.4: `x-run-id` is always
 * threaded through (generated if absent) and the SSO session cookie is
 * forwarded, via the shared `forwardSessionHeaders`. Read-only — no body.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'
import { windowToHours } from '@/lib/fleet-stats'

export const runtime = 'nodejs'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Resolve the upstream window: prefer the design preset token (`?window=7d`),
  // fall back to a bare numeric `?windowHours=N`. Both map to the dispatch
  // server's `windowHours` query (clamped upstream to 1–168); omitting both
  // lets dispatch use its 24h default.
  const win = req.nextUrl.searchParams.get('window')
  const windowHoursParam = req.nextUrl.searchParams.get('windowHours')
  const presetHours = windowToHours(win ?? undefined)
  const numericHours =
    windowHoursParam != null && windowHoursParam !== '' ? Number(windowHoursParam) : null
  const upstreamQuery =
    presetHours != null
      ? `?windowHours=${presetHours}`
      : numericHours != null && Number.isFinite(numericHours)
        ? `?windowHours=${Math.floor(numericHours)}`
        : ''
  const upstreamUrl = `${gatewayUrl()}/api/v1/dispatch/fleet-stats${upstreamQuery}`

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
      { success: false, error: 'fleet stats failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const body = await upstream.text()
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
