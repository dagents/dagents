/**
 * Console → gateway goal-advance proxy（方向 C，2026-11-10）。
 * POST 手动推进一轮（supervisor 同一代码路径）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', (req, { params }) =>
  params.then(({ id }) => `/api/v1/goals/${encodeURIComponent(id)}/advance`),
)
