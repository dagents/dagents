/**
 * Shared helpers for the `/api/workflows/*` gateway proxy routes.
 *
 * Both the collection route (`/api/workflows`) and the item route
 * (`/api/workflows/:id`) forward to the gateway's `/api/v1/workflows/*`
 * CRUD API. The wiring is identical except for the path segment, so the
 * URL-building / header-forwarding / response-piping live here once.
 *
 * 2026-09-17 代理收敛：forwardHeaders / fail / pipeUpstream 不再各自复制，
 * 一律从第一代 gateway-proxy 导出（单源）；本模块只保留 workflow 特有的
 * 路径前缀与 id 校验 + 带 svc 标签的错误日志。
 */

import { createLogger } from '@dagents/shared'
import { gatewayUrl } from '@/lib/config'

export { fail, forwardHeaders, pipeUpstream } from '@/lib/gateway-proxy'

const proxyLog = createLogger({ svc: 'console:workflow-proxy' })

export const WORKFLOW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/workflows${path}`
  return search ? `${base}${search}` : base
}

export function logProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}
