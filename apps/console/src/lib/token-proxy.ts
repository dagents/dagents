/**
 * Shared helpers for the `/api/tokens/*` gateway proxy routes (P1.10.T8).
 *
 * Both the collection route (`/api/tokens`) and the item route
 * (`/api/tokens/:id`) forward to the gateway's `/api/v1/tokens/*` admin
 * proxy. The wiring is identical except for the path segment, so the
 * URL-building / header-forwarding / response-piping live here once.
 *
 * See `apps/gateway/src/routes/tokens.ts` for the upstream contract: the
 * gateway authenticates to new-api with the admin key, rewrites
 * `/api/v1/tokens` → `/api/token`, and keeps `token_meta` in sync. The raw
 * key never traverses this hop (new-api masks it in its own responses).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@mil/shared'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'

/**
 * Server-side logger for the token proxy. Routes the raw fetch error to the
 * Next server log (pino via `@mil/shared`) — NOT to the browser. The client
 * only ever sees the sanitized `fail()` envelope; the detail stays here.
 */
const proxyLog = createLogger({ svc: 'console:tokens-proxy' })

/** Integer token id on the path — mirrors the gateway's `parseTokenId`. */
export const TOKEN_ID_RE = /^\d+$/

/** Build the gateway URL for a given token path segment + querystring. */
export function buildUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/tokens${path}`
  return search ? `${base}${search}` : base
}

/**
 * Headers forwarded to the gateway. Hop-by-hop + body-length are fetch's job.
 *
 * M5b.4: `x-run-id` is always set (generated if the caller omitted one) so the
 * token admin proxy's audit rows always carry a run id; the SSO session cookie
 * is threaded so the gateway's session middleware sees the caller. The
 * gateway's token route already forwards a caller-supplied `x-run-id` for
 * audit correlation; generating one here closes the gap when the browser
 * omitted it (the M5b.4 "所有请求带 run_id" bar).
 */
export function forwardHeaders(req: NextRequest, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'x-run-id': resolveRunId(req.headers.get('x-run-id')),
  }
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  if (hasBody) headers['content-type'] = req.headers.get('content-type') ?? 'application/json'
  return headers
}

/**
 * Sanitized JSON envelope for proxy-side failures (gateway dial / bad id).
 *
 * Does NOT echo the fetch error string back to the browser: `String(err)`
 * for a network failure can carry the internal gateway host/port/path
 * (e.g. `fetch failed for http://gateway:8080/...`), which leaks internal
 * topology to the client. The gateway's own 502 (`routes/tokens.ts`) keeps
 * the same posture — `{ success:false, error:'upstream error' }` with no
 * detail — and this hop matches it. The raw error is logged server-side at
 * the call site via `proxyLog`, never shipped to the client.
 */
export function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

/**
 * Log a proxy dial failure server-side only (never reaches the client).
 * Records the stage + error class so an operator can diagnose a down
 * gateway without the error string (which can carry internal URLs) ever
 * crossing into the browser response.
 */
export function logProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}

/**
 * Pipe the gateway Response back verbatim, preserving status + content-type.
 *
 * The body is buffered (token payloads are small JSON) so we can render it
 * as a NextResponse without the `duplex: 'half'` streaming complexity the
 * SSE chat path needs — token CRUD is request/response, not a stream.
 */
export async function pipeUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new NextResponse(body, { status: upstream.status, headers })
}
