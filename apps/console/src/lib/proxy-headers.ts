/**
 * Shared header-forwarding for the console → gateway proxy routes (M5b.4).
 *
 * Every console API route forwards to the gateway. Two headers matter for
 * SSO + run_id threading (the M5b.4 acceptance bar "登录可用, 所有请求带 run_id"):
 *
 *  - `x-run-id` — always set. The caller (browser) attaches the per-page run
 *    id; `resolveRunId` generates one if absent so a request that arrived with
 *    none still leaves the console carrying one. The gateway's OTel run-entry
 *    span + audit trail key off this.
 *  - `cookie` — forwarded so the gateway's SSO session middleware sees the
 *    `mil_session` cookie the console's `/api/auth/*` routes set. Same-origin
 *    the browser sends it to the console route automatically; this forwards it
 *    the next hop to the gateway (a server-side fetch does NOT auto-attach
 *    cookies the way a browser does, so we copy the header explicitly).
 *
 * `authorization` is also forwarded when present — the LLM/token paths use a
 * caller `sk-` token and the chat path may carry one; read paths don't send
 * it, which is fine. Centralizing the three here means a new proxy route can't
 * forget the run id or the session cookie (the exact gap M5b.4 closes).
 */

import type { NextRequest } from 'next/server'

/**
 * Build the headers to send to the gateway for a proxy hop. `runId` is the
 * resolved run id (already generated if absent — pass `resolveRunId(...)`).
 * `hasBody` adds `content-type: application/json` for POST/PUT bodies when the
 * caller didn't set one.
 */
export function forwardSessionHeaders(
  req: NextRequest,
  runId: string,
  hasBody = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-run-id': runId,
  }
  // Forward the session cookie so the gateway's SSO middleware sees the caller.
  // `req.cookies` is Hono/Next's parsed cookie bag; reconstructing the header
  // from it (rather than copying the raw `cookie` header) normalizes spacing
  // and avoids forwarding a malformed header a buggy client might send.
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  if (hasBody) {
    const ct = req.headers.get('content-type')
    headers['content-type'] = ct && ct.length > 0 ? ct : 'application/json'
  }
  return headers
}
