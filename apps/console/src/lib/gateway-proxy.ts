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
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'

type PathBuilder = string | ((req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => string | Promise<string>)

/**
 * Create a Next.js route handler that proxies to the gateway.
 *
 * @param method HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param upstreamPath The gateway path (string) or a function that builds it
 *   from the request + params (for dynamic routes like `/api/agents/[id]`).
 */
export function gatewayProxy(method: string, upstreamPath: PathBuilder) {
  async function handler(req: NextRequest, segmentData?: { params: Promise<Record<string, string>> }): Promise<NextResponse> {
    // Resolve the upstream path
    const path = typeof upstreamPath === 'function'
      ? await upstreamPath(req, segmentData ?? { params: Promise.resolve({}) })
      : upstreamPath

    const upstreamUrl = `${gatewayUrl()}${path}${req.nextUrl.search}`
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const runId = resolveRunId(req.headers.get('x-run-id'))
    const headers = forwardSessionHeaders(req, runId, hasBody)

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
      return NextResponse.json(
        { success: false, error: 'gateway unavailable' },
        { status: 502 },
      )
    }

    // Pipe the upstream response through — same status + content-type + body
    const responseBody = await upstream.text()
    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  }

  return handler
}
