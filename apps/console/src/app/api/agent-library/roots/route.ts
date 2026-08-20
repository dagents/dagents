/**
 * Console → gateway agent-library roots proxy（挂载目录管理）。
 *
 * DELETE 的 dir 走 query（gateway 同款约定：console 代理不转发 DELETE body）。
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = gatewayProxy('POST', '/api/v1/agent-library/roots')
export const DELETE = gatewayProxy('DELETE', '/api/v1/agent-library/roots')
