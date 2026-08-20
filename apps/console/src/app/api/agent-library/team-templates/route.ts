/**
 * Console → gateway team-template catalogue proxy（人格库的团队场景 tab）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/agent-library/team-templates')
