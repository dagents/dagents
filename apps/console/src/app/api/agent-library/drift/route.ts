/**
 * Console → gateway agent-library drift proxy（已启用人格的同步状态清单）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/agent-library/drift')
