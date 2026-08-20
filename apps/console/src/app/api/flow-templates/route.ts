/**
 * Console → gateway flow-template catalogue proxy（内置 + 用户模板合并列表）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/flow-templates')
