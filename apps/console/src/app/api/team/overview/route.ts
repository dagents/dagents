/**
 * Console → gateway team-overview proxy（方向 A，2026-11-10）。
 * GET only——作战室只读聚合（写路径在 flows / goals 各自的端点）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/team/overview')
