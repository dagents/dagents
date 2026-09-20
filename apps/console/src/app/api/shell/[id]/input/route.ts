/**
 * POST /api/shell/:id/input — 键入/粘贴写入 PTY（body: { data: base64 }）。
 */

import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', async (_req, { params }) => {
  const { id } = await params
  return `/api/v1/shell/${encodeURIComponent(id)}/input`
})
