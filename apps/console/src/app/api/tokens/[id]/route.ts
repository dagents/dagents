/**
 * Console → gateway token admin proxy — item-scoped verbs (P1.10.T8).
 *
 *   GET    /api/tokens/:id  → fetch one
 *   PUT    /api/tokens/:id  → update (body incl. optional `meta`)
 *   DELETE /api/tokens/:id  → delete
 *
 * Collection verbs (GET/POST `/api/tokens`) live in
 * `apps/console/src/app/api/tokens/route.ts`. The wiring is identical
 * except for the path segment, so the URL-building / header-forwarding /
 * response-piping helpers live in `@/lib/token-proxy`.
 *
 * `:id` is new-api's integer token id. We validate it is digits-only here
 * (mirroring the gateway's `parseTokenId`) so a non-numeric / traversal
 * segment is rejected at the console edge and never reaches the gateway.
 */

import { type NextRequest } from 'next/server'
import { buildUpstreamUrl, fail, forwardHeaders, logProxyError, pipeUpstream, TOKEN_ID_RE } from '@/lib/token-proxy'

export const runtime = 'nodejs'

/** GET /api/tokens/:id — fetch one. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const { id } = await ctx.params
  if (!id || !TOKEN_ID_RE.test(id)) return fail(400, 'invalid token id')
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}`, req.nextUrl.search), {
      method: 'GET',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('get', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}

/** PUT /api/tokens/:id — update. */
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const { id } = await ctx.params
  if (!id || !TOKEN_ID_RE.test(id)) return fail(400, 'invalid token id')
  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}`, req.nextUrl.search), {
      method: 'PUT',
      headers: forwardHeaders(req, true),
      body,
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('update', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}

/** DELETE /api/tokens/:id — delete. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const { id } = await ctx.params
  if (!id || !TOKEN_ID_RE.test(id)) return fail(400, 'invalid token id')
  let upstream: Response
  try {
    upstream = await fetch(buildUpstreamUrl(`/${id}`, req.nextUrl.search), {
      method: 'DELETE',
      headers: forwardHeaders(req, false),
      cache: 'no-store',
    })
  } catch (err) {
    logProxyError('delete', err)
    return fail(502, 'gateway unavailable')
  }
  return pipeUpstream(upstream)
}
