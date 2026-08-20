/**
 * Console → gateway agent-library catalogue proxy.
 *
 * GET /api/agent-library → GET /api/v1/agent-library（divisions + entries + roots）。
 * ?division= 与 ?refresh= 原样透传（gatewayProxy 拼 req.nextUrl.search）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/agent-library')
