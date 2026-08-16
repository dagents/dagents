/**
 * Console → gateway task-events proxy.
 *
 * Forwards `GET /api/dispatch/tasks/:id/events` to
 * `${gatewayUrl()}/api/v1/dispatch/tasks/:id/events`. Query string (e.g.
 * `?after=N` for incremental polling) is forwarded by `gatewayProxy` via
 * `req.nextUrl.search`. Response envelope: `{ success, data: { events } }`
 * with events ordered by `seq` ascending.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/dispatch/tasks/${encodeURIComponent(id)}/events`
})
