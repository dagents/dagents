/**
 * POST /api/shell/:id/resize — 视口尺寸同步（body: { cols, rows }）。
 */

import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/shell/${encodeURIComponent(id)}/resize`
})
