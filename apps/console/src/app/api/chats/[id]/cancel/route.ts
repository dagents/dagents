import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/chats/:id/cancel — user-initiated execution cancel
 * (execution-cancellation spec D5/D6). Proxies the gateway's registry-backed
 * cancel; 409 (nothing running) passes through so the UI can treat it as
 * "already finished".
 */
export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/chats/${encodeURIComponent(id)}/cancel`
})
