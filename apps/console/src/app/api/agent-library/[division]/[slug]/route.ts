/**
 * Console → gateway agent-library entry detail proxy.
 *
 * GET /api/agent-library/[division]/[slug] → 人格原文 + 三档编译预览 +
 * 已启用/drift 状态。division/slug 是库寻址键（slug 由 frontmatter name
 * slug 化而来），encodeURIComponent 防路径注入。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', async (_req, { params }) => {
  const { division, slug } = await params
  return `/api/v1/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}`
})
