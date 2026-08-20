/**
 * Console → gateway agent-library reimport proxy（按最新库文件覆盖 instructions）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { division, slug } = await params
  return `/api/v1/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}/reimport`
})
