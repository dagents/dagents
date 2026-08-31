/**
 * Console BFF: POST /api/runs/summary —— 每-flow 运行摘要薄代理（PRD FR-04）。
 *
 * 透传 gateway `POST /api/v1/runs/summary`。列表页 35 张卡片的徽章数据
 * 一次请求拉齐（杜绝逐卡 ?flowId= 的 N+1）。
 */
import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.json().catch(() => null)
  const upstream = await fetch(`${gatewayUrl()}/api/v1/runs/summary`, {
    method: 'POST',
    headers: { ...forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id'))), 'content-type': 'application/json' },
    body: JSON.stringify(body ?? { flowIds: [] }),
    cache: 'no-store',
  })
  const json = await upstream.json().catch(() => ({ success: false, error: '网关响应不可解析' }))
  return NextResponse.json(json, { status: upstream.status })
}
