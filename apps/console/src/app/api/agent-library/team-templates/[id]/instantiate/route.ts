/**
 * Console → gateway team-template instantiate proxy
 * （解析人格 → 复用/启用成员 → draft flow → 跳画布）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/agent-library/team-templates/${encodeURIComponent(id)}/instantiate`
})
