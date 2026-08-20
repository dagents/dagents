/**
 * Console → gateway from-flow proxy（画布「另存为模板」：抽取+清洗+入库）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { flowId } = await params
  return `/api/v1/flow-templates/from-flow/${encodeURIComponent(flowId)}`
})
