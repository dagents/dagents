/**
 * Shared helpers for the `/api/llm-providers/*` gateway proxy routes.
 *
 * Both the collection route (`/api/llm-providers`) and the item route
 * (`/api/llm-providers/:id`) forward to the gateway's `/api/v1/llm-providers/*`
 * CRUD API. The wiring is identical except for the path segment, so the
 * URL-building / header-forwarding / response-piping live here once.
 *
 * See `apps/gateway/src/routes/llm-providers.ts` for the upstream contract.
 * The API key is stored base64-encoded and returned masked — the raw key
 * never traverses this hop.
 *
 * 2026-09-17 代理收敛：forwardHeaders / fail / pipeUpstream 不再各自复制，
 * 一律从第一代 gateway-proxy 导出（单源）；本模块只保留 llm-providers
 * 特有的路径前缀与 id 校验 + 带 svc 标签的错误日志。
 */

import { createLogger } from '@dagents/shared'
import { gatewayUrl } from '@/lib/config'

export { fail, forwardHeaders, pipeUpstream } from '@/lib/gateway-proxy'

const proxyLog = createLogger({ svc: 'console:llm-providers-proxy' })

export const PROVIDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/llm-providers${path}`
  return search ? `${base}${search}` : base
}

export function logProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}
