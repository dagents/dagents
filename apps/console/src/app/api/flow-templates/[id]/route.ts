/**
 * Console → gateway 用户模板 delete proxy（uuid 寻址）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = gatewayProxy('DELETE', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/flow-templates/${encodeURIComponent(id)}`
})
