/**
 * Shared helpers for the `/api/lab/*` gateway proxy routes (M5b.2 / P1.10.T7).
 *
 * The console Lab page talks to the gateway's `/api/v1/lab/*` API
 * (`apps/gateway/src/routes/lab.ts`). Keeping the gateway URL + header
 * forwarding + response piping here mirrors `workspace-proxy.ts`: the session
 * routes and the message-scoped routes share identical wiring except for the
 * path segment, so the boilerplate lives once.
 *
 * `x-run-id` is threaded through for trace correlation (M6.1) — an append
 * pins the caller's run id into the lab_messages row so a turn is
 * end-to-end traceable. The gateway URL stays server-side (no CORS, no origin
 * leak), matching the chat / tokens / workspace proxies' posture.
 *
 * Failures are sanitized: a gateway dial error never carries the internal
 * gateway host/port/path to the browser (`logProxyError` records the error
 * class server-side only); the gateway's own 502/503/404/400 envelopes are
 * piped verbatim so the view can surface the reason.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@mil/shared'
import { gatewayUrl, MAX_RUN_ID_LEN } from '@/lib/config'

const proxyLog = createLogger({ svc: 'console:lab-proxy' })

/** Build the gateway URL for a lab path segment + querystring. */
export function buildLabUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/lab${path}`
  return search ? `${base}${search}` : base
}

/**
 * Headers forwarded to the gateway. Hop-by-hop + body-length are fetch's job;
 * we only thread the run id (for trace correlation + lab_messages pinning on
 * append) + the caller's auth + the content-type on a POST body.
 */
export function forwardLabHeaders(
  req: NextRequest,
  contentType?: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const runId = req.headers.get('x-run-id')?.trim()
  if (runId && runId.length <= MAX_RUN_ID_LEN) headers['x-run-id'] = runId
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  if (contentType) headers['content-type'] = contentType
  return headers
}

/** Sanitized JSON envelope for a proxy-side dial failure (gateway unreachable). */
export function labFail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

/** Log a proxy dial failure server-side only (never reaches the client). */
export function labLogProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}

/**
 * Pipe the gateway Response back verbatim, preserving status + content-type.
 *
 * Lab payloads are small JSON (session list / detail / thread / append), so
 * the body is buffered — no `duplex: 'half'` streaming complexity (that's
 * only the SSE chat path). The gateway already allowlists response headers,
 * so nothing internal leaks.
 */
export async function pipeLabUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new NextResponse(body, { status: upstream.status, headers })
}
