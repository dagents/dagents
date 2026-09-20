/**
 * Console → gateway shell 会话代理：GET 列表 / POST 新建 PTY 会话。
 * 会话本体与协议见 gateway `src/routes/shell.ts`。
 */

import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/shell')
export const POST = gatewayProxy('POST', '/api/v1/shell')
