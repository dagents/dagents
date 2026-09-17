/**
 * Console → gateway fleet-stats proxy (M6.3 / P1.11.T4).
 *
 * The dashboard view GETs `/api/fleet-stats`; this route forwards to the
 * gateway's blind dispatch passthrough
 * (`${gatewayUrl()}/api/v1/dispatch/fleet-stats`), which forwards verbatim to
 * the dispatch server's `GET /fleet-stats` (apps/dispatch/src/routes/fleet-stats.ts,
 * the M6.5 aggregation API). Same posture as `api/agents/route.ts`: the gateway
 * URL stays server-side (no CORS, no origin leak), and upstream non-2xx gets
 * a truncated detail envelope the view can surface. Read-only — no body.
 *
 * The window query param sizes the throughput/cost window. The M8.1 redesign
 * sends the design's preset token as `?window=1h|24h|7d`; this proxy resolves
 * it to the numeric `windowHours` the dispatch server consumes (clamped to
 * 1–168) and forwards that upstream. A bare `?windowHours=N` is still honored
 * for back-compat with any direct numeric caller. `x-run-id` is always
 * threaded through (generated if absent). 
 *
 * 2026-09-17 代理收敛：手写内联转发改为 gatewayProxy 一行；window 预设 →
 * windowHours 的翻译是真实适配，保留在路径构建器里（构建器自带查询串时
 * gatewayProxy 不再拼接原始 search）。
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayProxy } from '@/lib/gateway-proxy'
import { windowToHours } from '@/lib/fleet-stats'

export const runtime = 'nodejs'

/** 上游路径 + 查询翻译：优先设计预设 token（?window=7d），回落裸数字
 *  （?windowHours=N）；两者都缺省时不带查询（dispatch 用其 24h 默认）。 */
function buildFleetStatsPath(req: NextRequest): string {
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
  return `/api/v1/dispatch/fleet-stats${upstreamQuery}`
}

export const GET = gatewayProxy('GET', buildFleetStatsPath, {
  transformError: (upstream, body) =>
    NextResponse.json(
      {
        success: false,
        error: 'fleet stats failed',
        status: upstream.status,
        detail: body.slice(0, 500),
      },
      { status: upstream.status },
    ),
})
