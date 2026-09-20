/**
 * DELETE /api/shell/:id — 杀掉并移除 shell 会话。
 */

import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = gatewayProxy('DELETE', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/shell/${encodeURIComponent(id)}`
})
