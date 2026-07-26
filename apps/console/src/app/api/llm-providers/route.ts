/**
 * Console → gateway LLM provider proxy.
 *
 * The settings "LLM Provider" tab drives this route for CRUD on LLM providers.
 * The browser never talks to the gateway directly: it calls this route, which
 * forwards to the gateway's `/api/v1/llm-providers/*` API. Keeping the gateway
 * URL server-side avoids CORS and keeps the gateway origin out of the client
 * bundle — the same posture as the `/api/chat` proxy.
 *
 * Path contract (mirrors the gateway's RESTful form):
 *   GET    /api/llm-providers            → list
 *   POST   /api/llm-providers            → create
 *
 * Item-scoped verbs (GET/PATCH/DELETE `/api/llm-providers/:id`) live in
 * `apps/console/src/app/api/llm-providers/[id]/route.ts`. The wiring is
 * identical except for the path segment, so the URL-building /
 * header-forwarding / response-piping helpers live in
 * `@/lib/llm-provider-proxy`.
 */

import { type NextRequest } from 'next/server'
import { buildUpstreamUrl, fail, forwardHeaders, logProxyError, pipeUpstream } from '@/lib/llm-provider-proxy'

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
