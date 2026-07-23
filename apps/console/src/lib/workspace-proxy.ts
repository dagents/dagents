/**
 * Shared helpers for the `/api/workspaces/*` gateway proxy routes (M5b.1 /
 * P1.10.T6).
 *
 * The console Workspace page talks to the gateway's `/api/v1/workspaces/*`
 * read API (`apps/gateway/src/routes/workspaces.ts`). Keeping the gateway URL
 * + header forwarding + response piping here mirrors `token-proxy.ts`: the
 * collection route and the item-scoped routes share identical wiring except
 * for the path segment, so the boilerplate lives once.
 *
 * `x-run-id` is threaded through for trace correlation (M6.1) — these reads
 * don't generate a run, but forwarding the caller's keeps the console→gateway
 * hop in the same trace. M5b.4: the SSO session cookie is also forwarded so the
 * gateway's session middleware sees the caller — without it, opening
 * `REQUIRE_LOGIN=1` 401s the Workspace page for logged-in users. The gateway
 * URL stays server-side (no CORS, no origin leak), matching the chat / tokens /
 * fleet-stats proxies' posture.
 *
 * Failures are sanitized: a gateway dial error never carries the internal
 * gateway host/port/path to the browser (`logProxyError` records the error
 * class server-side only); the gateway's own 502/503/404/400 envelopes are
 * piped verbatim so the view can surface the reason.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@mil/shared'
import { gatewayUrl, MAX_RUN_ID_LEN } from '@/lib/config'

const proxyLog = createLogger({ svc: 'console:workspaces-proxy' })

/** Build the gateway URL for a workspace path segment + querystring. */
export function buildWorkspaceUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/workspaces${path}`
  return search ? `${base}${search}` : base
}

/**
 * Headers forwarded to the gateway. Hop-by-hop + body-length are fetch's job;
 * we thread the run id (for trace correlation), the caller's auth, and —
 * M5b.4 — the SSO session cookie so the gateway's session middleware sees the
 * caller under `REQUIRE_LOGIN=1` (otherwise the Workspace page 401s for
 * logged-in users, violating "登录可用").
 */
export function forwardWorkspaceHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {}
  const runId = req.headers.get('x-run-id')?.trim()
  if (runId && runId.length <= MAX_RUN_ID_LEN) headers['x-run-id'] = runId
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  return headers
}

/** Sanitized JSON envelope for a proxy-side dial failure (gateway unreachable). */
export function workspaceFail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

/** Log a proxy dial failure server-side only (never reaches the client). */
export function workspaceLogProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}

/**
 * Pipe the gateway Response back verbatim, preserving status + content-type.
 *
 * Workspace payloads are small JSON (project list / detail / thread / quota),
 * so the body is buffered — no `duplex: 'half'` streaming complexity (that's
 * only the SSE chat path). The gateway already allowlists response headers,
 * so nothing internal leaks.
 */
export async function pipeWorkspaceUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new NextResponse(body, { status: upstream.status, headers })
}
