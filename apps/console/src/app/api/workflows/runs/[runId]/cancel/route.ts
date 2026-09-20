/**
 * 运行取消 BFF 透传（2026-09-20 PM 走查）：POST cancel —— 运行结果面板
 * 「停止」按钮的接线。薄代理。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (req, { params }) => {
  const { runId } = await params
  void req
  return `/api/v1/workflows/runs/${runId}/cancel`
})
