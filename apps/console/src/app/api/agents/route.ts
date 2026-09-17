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
 * console change. `x-run-id` is always threaded through (generated if
 * the caller omitted one, so every hop is traceable).
 *
 * 2026-09-17 代理收敛：手写内联转发改为 gatewayProxy 一行。上游非 2xx 的
 * envelope 适配（截断 500 字的 detail 字段）保留 —— 前端 unwrap 把响应
 * 文本拼进错误消息，detail 让列表页能看到网关侧失败原因。POST 的 JSON
 * 预校验交给网关 zod（响应原样透传，错误文案即网关的）。
 */

import { NextResponse } from 'next/server'
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'

export const GET = gatewayProxy('GET', '/api/v1/agents', {
  transformError: (upstream, body) =>
    NextResponse.json(
      {
        success: false,
        error: 'agents list failed',
        status: upstream.status,
        detail: body.slice(0, 500),
      },
      { status: upstream.status },
    ),
})

export const POST = gatewayProxy('POST', '/api/v1/agents')
