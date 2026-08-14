/**
 * Shared header-forwarding for the console → gateway proxy routes.
 *
 * Every console API route forwards to the gateway. The header that always
 * matters is the run-id thread:
 *
 *  - `x-run-id` — always set. The caller (browser) attaches the per-page run
 *    id; `resolveRunId` generates one if absent so a request that arrived with
 *    none still leaves the console carrying one. The gateway's OTel run-entry
 *    span + audit trail key off this.
 *
 * `cookie` and `authorization` are also forwarded when present — there is no
 * login (本机模式), but the LLM/token paths use a caller `sk-` token and a
 * future hop may carry a gateway API key, so both headers pass through
 * untouched. Centralizing them here means a new proxy route can't forget the
 * run id (the exact gap this helper closes).
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
  // Forward cookies verbatim (no login exists; kept so any future hop that
  // relies on a cookie keeps working). `req.headers.get('cookie')` is the raw
  // header — we copy it explicitly because a server-side fetch does NOT
  // auto-attach cookies the way a browser does.
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
