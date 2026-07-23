/**
 * Console → gateway auth proxy — login (plan M5b.4 / P1.10.T10).
 *
 * The browser talks to `/api/auth/login`; this route forwards the creds to
 * the gateway's `/api/v1/auth/login` and holds the returned session token in
 * an HttpOnly `mil_session` cookie. The token never reaches the browser
 * bundle; the cookie is what the browser stores and what the other console
 * proxy routes forward to the gateway (`forwardSessionHeaders`).
 *
 *   POST /api/auth/login    { username, password } → { user } (+ sets cookie)
 *
 * Posture matches the other console proxies: the gateway URL stays server-side
 * (no CORS, no origin leak), upstream non-2xx is surfaced to the caller, and
 * the route is a thin forwarder. The gateway owns the auth logic (sign/verify
 * the token); the console owns the cookie transport.
 *
 * App Router routes by file path: `api/auth/login/route.ts` serves exactly
 * `/api/auth/login` (NOT `/api/auth`), so the browser fetches in
 * `auth-client.tsx` resolve here instead of 404'ing. A single `api/auth/route.ts`
 * would only serve `/api/auth` and shadow none of the sub-paths.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { setSessionCookie, type SessionUser } from '@/lib/session'

export const runtime = 'nodejs'

/** Standard envelope (shared with the gateway). */
interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * POST /api/auth/login — forward creds to the gateway, set the session cookie
 * on success. Returns `{ user }` (NOT the token — the token lives only in the
 * cookie) on 200, or the gateway's error envelope on non-2xx.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text()
  let upstream: Response
  try {
    upstream = await fetch(`${gatewayUrl()}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': req.headers.get('content-type') ?? 'application/json',
        'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      },
      body,
      cache: 'no-store',
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  // Non-2xx (401 bad creds, 503 not configured, 400 bad body): pass through
  // without touching the cookie so a failed login doesn't clobber an existing
  // session.
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return NextResponse.json(
      { success: false, error: 'login failed', status: upstream.status, detail: detail.slice(0, 500) },
      { status: upstream.status },
    )
  }

  const parsed = (await upstream.json().catch(() => null)) as Envelope<{ token: string; user: SessionUser }> | null
  if (!parsed?.success || !parsed.data?.token) {
    return NextResponse.json(
      { success: false, error: 'login returned no token' },
      { status: 502 },
    )
  }

  const res = NextResponse.json({ success: true, data: { user: parsed.data.user } })
  setSessionCookie(res.cookies, parsed.data.token)
  return res
}
