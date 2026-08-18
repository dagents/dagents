import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = gatewayProxy('GET', async (_req, { params }) => {
  const { name } = await params
  return `/api/v1/skills/${encodeURIComponent(name)}`
})
