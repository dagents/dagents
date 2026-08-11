/**
 * Console → gateway agent-template instantiate proxy.
 *
 * Forwards POST /api/agent-templates/[id]/instantiate to the gateway, which
 * writes a real `agents` row (+ optional `agent_daemons` bridge) from the
 * template identified by [id]. The dynamic [id] segment is threaded through to
 * the upstream path via the gatewayProxy path-builder.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/agent-templates/${encodeURIComponent(id)}/instantiate`
})
