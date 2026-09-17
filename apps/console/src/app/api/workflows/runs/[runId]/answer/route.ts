/**
 * 断点续跑 BFF 透传（2026-09-18 §6.5）：POST answer —— awaiting 挂起的
 * 应答（同 runId 原地续跑）。薄代理。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (req, { params }) => {
  const { runId } = await params
  void req
  return `/api/v1/workflows/runs/${runId}/answer`
})
