import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 自定义技能目录管理：输入即加载（POST 校验 + 持久化 + 强制重扫）。
// DELETE 走 query 参数 —— gatewayProxy 不为 DELETE 转发请求体；
// query 由 gatewayProxy 统一追加（path builder 不要自己拼 search）。
export const POST = gatewayProxy('POST', () => '/api/v1/skills/roots')
export const DELETE = gatewayProxy('DELETE', () => '/api/v1/skills/roots')
