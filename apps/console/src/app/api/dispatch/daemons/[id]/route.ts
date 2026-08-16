/**
 * Console → gateway daemon-deregister proxy.
 *
 * Forwards `DELETE /api/dispatch/daemons/:id` to
 * `${gatewayUrl()}/api/v1/dispatch/daemons/:id` (dispatch daemon lifecycle
 * route). The gateway returns 204 on success / 404 for an unknown daemon id;
 * both are piped through verbatim so the UI can surface the failure.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = gatewayProxy('DELETE', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/dispatch/daemons/${encodeURIComponent(id)}`
})
