/**
 * 断点续跑 BFF 透传（2026-09-18 §6.5）：GET checkpoint —— UI 判定
 * resumable/awaiting 的数据源。薄代理（BFF rule: proxy only）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', async (req, { params }) => {
  const { runId } = await params
  void req
  return `/api/v1/workflows/runs/${runId}/checkpoint`
})
