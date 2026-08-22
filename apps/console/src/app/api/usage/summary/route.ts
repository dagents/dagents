/**
 * BFF proxy（AD-5 纯代理）→ gateway `GET /api/v1/usage/summary`。
 *
 * 账单汇总（方案 D / AD-3）：usage_events 的 SQL 聚合（totals/byDay/
 * byAgent/byFlow）。查询串（?days=30）原样透传，无本地逻辑。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = gatewayProxy('GET', '/api/v1/usage/summary')
