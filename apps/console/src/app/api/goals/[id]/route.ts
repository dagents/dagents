/**
 * Console → gateway goal-detail proxy（方向 C，2026-11-10）。
 * GET 详情+轮次谱系 / PATCH 编辑与状态机 / DELETE 删除。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', (req, { params }) =>
  params.then(({ id }) => `/api/v1/goals/${encodeURIComponent(id)}`),
)
export const PATCH = gatewayProxy('PATCH', (req, { params }) =>
  params.then(({ id }) => `/api/v1/goals/${encodeURIComponent(id)}`),
)
export const DELETE = gatewayProxy('DELETE', (req, { params }) =>
  params.then(({ id }) => `/api/v1/goals/${encodeURIComponent(id)}`),
)
