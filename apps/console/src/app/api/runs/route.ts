/**
 * Console BFF: GET /api/runs —— 跨 Flow 运行历史薄代理（PRD F5）。
 *
 * 透传 gateway `GET /api/v1/runs`（limit/status/flowId），会话头由
 * forwardSessionHeaders 统一处理。无形状改写 —— 页面直接消费网关契约。
 */
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  const qs = new URL(req.url).search
  const upstream = await fetch(`${gatewayUrl()}/api/v1/runs${qs}`, {
    headers: forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id'))),
    cache: 'no-store',
  })
  const json = await upstream.json().catch(() => ({ success: false, error: '网关响应不可解析' }))
  return NextResponse.json(json, { status: upstream.status })
}
