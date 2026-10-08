/**
 * 试运行 mock 调用记录 BFF 透传（R10 证据面板辅源）：GET
 * /api/runs/:runId/trial-calls。404 = 网关重启丢失/非试运行（诚实回退）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', async (_req, { params }) => {
  const { runId } = await params
  return `/api/v1/runs/${runId}/trial-calls`
})
