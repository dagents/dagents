/**
 * 画布试运行 BFF 透传（R10，design-sharp §4.6）：POST /api/workflows/:id/trial
 * —— 试运行面板的启动入口。薄代理（gateway async 恒一，立即返回 runId）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/workflows/${id}/trial`
})
