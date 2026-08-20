/**
 * Console → gateway builtin flow-template instantiate proxy（'builtin/&lt;slug&gt;' 含斜杠，
 * 与用户模板 uuid 分开寻址）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { slug } = await params
  return `/api/v1/flow-templates/builtin/${encodeURIComponent(slug)}/instantiate`
})
