/**
 * Console → gateway builtin flow-template delete proxy（始终 405，保护内置模板）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = gatewayProxy('DELETE', async (_req, { params }) => {
  const { slug } = await params
  return `/api/v1/flow-templates/builtin/${encodeURIComponent(slug)}`
})
