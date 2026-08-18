import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// gatewayProxy 自动追加 req.nextUrl.search —— path builder 不要再拼，
// 否则 ?refresh=1 变成 ?refresh=1?refresh=1，强制刷新被静默吞掉（TTL 缓存
// 命中，页面「刷新」按钮失效）。同 audit/chats-search 路由的既有注释。
export const GET = gatewayProxy('GET', () => '/api/v1/skills')
