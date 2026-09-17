/**
 * gateway-proxy.ts — eliminates boilerplate in console → gateway proxy routes.
 *
 * Every console API route does the same 5 things:
 *   1. Build the upstream gateway URL
 *   2. Forward session headers + run-id
 *   3. fetch() with the right method + body
 *   4. Catch network errors → 502
 *   5. Pipe the upstream response body + status + content-type back
 *
 * This function wraps that pattern so route files shrink to ~5 lines.
 *
 * Usage:
 *   // app/api/directories/route.ts
 *   import { gatewayProxy } from '@/lib/gateway-proxy'
 *   export const runtime = 'nodejs'
 *   export const dynamic = 'force-dynamic'
 *   export const GET = gatewayProxy('GET', '/api/v1/directories')
 *   export const POST = gatewayProxy('POST', '/api/v1/directories')
 *
 * For routes that need custom upstream path logic (e.g. deriving an id from
 * params), pass a function instead of a string:
 *   export const DELETE = gatewayProxy('DELETE', (req, { params }) =>
 *     `/api/v1/agents/${params.id}`)
 *
 * 路径构建器返回的 path 已含 `?` 时不再拼接 req.nextUrl.search ——
 * 需要改写查询串的路由（如 fleet-stats 的 window 预设翻译）在构建器里
 * 自己产出完整查询。
 *
 * 2026-09-17 代理收敛：本模块同时是代理原语的唯一归属 —— 第二代代理
 * 模块（workflow-proxy / llm-provider-proxy）此前各自复制的
 * forwardHeaders / fail / pipeUpstream 一律从这里导出；网关非 2xx 需要
 * 自有 envelope（如截断 detail 字段）的路由经 transformError 适配。
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

type PathBuilder = string | ((req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => string | Promise<string>)

/** 统一的失败 envelope：`{ success: false, error }` + 状态码。 */
export function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

/** 会话头转发（run-id 线程 + cookie/authorization + body content-type）——
 *  resolveRunId + forwardSessionHeaders 的组合单源。 */
export function forwardHeaders(req: NextRequest, hasBody: boolean): Record<string, string> {
  return forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id')), hasBody)
}

/** 透传上游响应：status + content-type + 上游回带的 x-run-id（浏览器拿它
 *  直达运行详情；网关只在 run 类端点上设置，其余路由无副作用）。 */
export async function pipeUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  const runId = upstream.headers.get('x-run-id')
  if (runId) headers.set('x-run-id', runId)
  return new NextResponse(body, { status: upstream.status, headers })
}

export interface GatewayProxyOptions {
  /** 上游非 2xx 时的响应适配（可选）：默认原样透传 status + body；需要把
   *  上游错误体收敛成自有 envelope（截断 detail 字段 / 5xx 归一 502）的
   *  路由在此改写。收到的是上游 Response 与已读出的 body 文本。 */
  transformError?: (upstream: Response, body: string) => NextResponse
}

/**
 * Create a Next.js route handler that proxies to the gateway.
 *
 * @param method HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param upstreamPath The gateway path (string) or a function that builds it
 *   from the request + params (for dynamic routes like `/api/agents/[id]`).
 * @param opts 可选的响应适配（transformError）。
 */
export function gatewayProxy(method: string, upstreamPath: PathBuilder, opts: GatewayProxyOptions = {}) {
  // Second param must be required (Next 15 route-context validation rejects
  // signatures that admit `undefined`). Next always passes the context object,
  // even for non-dynamic routes.
  async function handler(
    req: NextRequest,
    segmentData: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    // Resolve the upstream path
    const path = typeof upstreamPath === 'function'
      ? await upstreamPath(req, segmentData)
      : upstreamPath

    // 构建器自带查询串时不再拼接（查询改写型路由的出口）
    const search = path.includes('?') ? '' : req.nextUrl.search
    const upstreamUrl = `${gatewayUrl()}${path}${search}`
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const headers = forwardHeaders(req, hasBody)

    // For methods with a body, read it from the incoming request
    let body: string | undefined
    if (hasBody) {
      body = await req.text()
    }

    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method,
        cache: 'no-store',
        headers,
        ...(body !== undefined ? { body } : {}),
      })
    } catch {
      return fail(502, 'gateway unavailable')
    }

    const responseBody = await upstream.text()
    if (!upstream.ok && opts.transformError) {
      return opts.transformError(upstream, responseBody)
    }
    // Pipe the upstream response through — same status + content-type + body
    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        ...(upstream.headers.get('x-run-id')
          ? { 'x-run-id': upstream.headers.get('x-run-id') as string }
          : {}),
      },
    })
  }

  return handler
}
