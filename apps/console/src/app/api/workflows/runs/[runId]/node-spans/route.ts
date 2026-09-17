/**
 * Console → gateway node-spans proxy.
 *
 * After the scheduler merge (Plan A 2026-08-01), the gateway owns both the
 * write path (`POST /api/v1/workflows/:id/run` writes `run_node_spans`) and
 * the read path (`GET /api/v1/workflows/runs/:runId/node-spans`). The browser
 * never talks to the gateway directly: it calls this Next API route, which
 * keeps the gateway URL server-side.
 *
 * Read-only (GET). 4xx from the gateway is forwarded with a truncated detail
 * envelope so the caller can distinguish "bad run id" / "no such run" from
 * "gateway down"; 5xx collapses to a sanitized 502 (upstreamStatus carried).
 *
 * 2026-09-17 代理收敛：手写内联转发改为 gatewayProxy 一行，错误面经
 * transformError 适配（4xx detail envelope / 5xx 归一 502）。
 */

import { NextResponse } from 'next/server'
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'

export const GET = gatewayProxy(
  'GET',
  async (_req, { params }) => {
    const { runId } = await params
    return `/api/v1/workflows/runs/${encodeURIComponent(runId)}/node-spans`
  },
  {
    transformError: (upstream, body) =>
      upstream.status >= 500
        ? NextResponse.json(
            { success: false, error: 'upstream error', upstreamStatus: upstream.status },
            { status: 502 },
          )
        : NextResponse.json(
            {
              success: false,
              error: 'node-spans failed',
              status: upstream.status,
              detail: body.slice(0, 500),
            },
            { status: upstream.status },
          ),
  },
)
