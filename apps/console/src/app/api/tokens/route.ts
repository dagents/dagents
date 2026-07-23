/**
 * Console → gateway token admin proxy (P1.10.T8).
 *
 * The settings "API Key" tab drives this route for CRUD on new-api tokens.
 * The browser never talks to new-api directly: it calls this route, which
 * forwards to the gateway's `/api/v1/tokens/*` admin proxy
 * (`apps/gateway/src/routes/tokens.ts`), which in turn dials new-api with
 * the admin key and keeps `token_meta` in sync. Keeping the gateway URL
 * server-side avoids CORS and keeps the new-api origin + admin credentials
 * out of the client bundle — the same posture as the `/api/chat` proxy.
 *
 * Path contract (mirrors the gateway's RESTful form):
 *   GET    /api/tokens            → list (new-api paginated)
 *   POST   /api/tokens            → create (body = new-api token payload + optional `meta`)
 *
 * Item-scoped verbs (GET/PUT/DELETE `/api/tokens/:id`) live in
 * `apps/console/src/app/api/tokens/[id]/route.ts`. The wiring is identical
 * except for the path segment, so the URL-building / header-forwarding /
 * response-piping helpers live in `@/lib/token-proxy`.
 *
 * The gateway collapses every new-api non-2xx to a sanitized 502 and
 * returns 503 when the admin key isn't configured; we pass both statuses
 * through so the UI can distinguish "upstream problem" (502) from "not
 * wired up" (503). The gateway already allowlists response headers, so
 * nothing internal leaks.
 *
 * `x-run-id` is forwarded when present — the gateway's token proxy does
 * not generate one, but threading the caller's through keeps audit/trace
 * correlation consistent with the chat path.
 */

import { type NextRequest } from 'next/server'
import { buildUpstreamUrl, fail, forwardHeaders, logProxyError, pipeUpstream } from '@/lib/token-proxy'

export const runtime = 'nodejs'

/** GET /api/tokens — list. Forwards new-api's paginated response verbatim. */
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

/** POST /api/tokens — create. Body is the new-api token payload (+ optional `meta`). */
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
