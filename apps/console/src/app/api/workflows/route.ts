/**
 * Console → gateway workflow proxy.
 *
 * Forwards workflow CRUD operations to the gateway's `/api/v1/workflows/*` API.
 * The browser never talks to the gateway directly: it calls this route, which
 * forwards to the gateway. Keeping the gateway URL server-side avoids CORS
 * and keeps the gateway origin out of the client bundle.
 *
 * Path contract (mirrors the gateway's RESTful form):
 *   GET    /api/workflows            → list
 *   POST   /api/workflows            → create
 *
 * Item-scoped verbs (GET/PUT/DELETE `/api/workflows/:id`) live in
 * `apps/console/src/app/api/workflows/[id]/route.ts`. The wiring is
 * identical except for the path segment, so the URL-building /
 * header-forwarding / response-piping helpers live in
 * `@/lib/workflow-proxy`.
 */

import { type NextRequest } from 'next/server'
import { buildUpstreamUrl, fail, forwardHeaders, logProxyError, pipeUpstream } from '@/lib/workflow-proxy'

export const runtime = 'nodejs'

export async function GET(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl('', req.nextUrl.search), {
      method: 'GET',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('list', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl('', req.nextUrl.search), {
      method: 'POST',
      headers: forwardHeaders(req, true),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('create', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
