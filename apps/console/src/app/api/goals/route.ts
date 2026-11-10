/**
 * Console → gateway goals proxy（方向 C，2026-11-10）。
 * GET 列表（?all=1 含归档）/ POST 创建。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/goals')
export const POST = gatewayProxy('POST', '/api/v1/goals')
