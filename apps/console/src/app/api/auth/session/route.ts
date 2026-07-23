/**
 * Console → gateway auth proxy — session check (plan M5b.4 / P1.10.T10).
 *
 *   GET /api/auth/session  → { user } | 401  (reads the cookie)
 *
 * Forwards the session cookie to the gateway's `/api/v1/auth/session` and
 * returns `{ user }` on 200, or 401 on no session. The browser uses this on
 * mount (SessionProvider) to decide login vs app.
 *
 * App Router routes by file path: `api/auth/session/route.ts` serves exactly
 * `/api/auth/session`, so the browser fetch in `auth-client.tsx` resolves here
 * instead of 404'ing.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { readSessionCookie, type SessionUser } from '@/lib/session'

export const runtime = 'nodejs'

/** Standard envelope (shared with the gateway). */
interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * GET /api/auth/session — forward the session cookie to the gateway's
 * `/api/v1/auth/session` and return `{ user }` on 200, or 401 on no session.
 * The browser uses this on mount to decide login vs app.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = readSessionCookie(req.headers.get('cookie'))
  let upstream: Response
  try {
    upstream = await fetch(`${gatewayUrl()}/api/v1/auth/session`, {
      method: 'GET',
      // Send the session cookie as the gateway expects it (mil_session=<token>).
      // The gateway's `tokenFromRequest` reads it from the cookie header.
      headers: {
        cookie: token ? `mil_session=${token}` : '',
        'x-run-id': resolveRunId(req.headers.get('x-run-id')),
      },
      cache: 'no-store',
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'gateway unavailable', detail: String(err) },
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    // 401 (no session) or 503 (not configured): pass the status through.
    return NextResponse.json(
      { success: false, error: 'no session', status: upstream.status },
      { status: upstream.status },
    )
  }

  const parsed = (await upstream.json().catch(() => null)) as Envelope<{ user: SessionUser }> | null
  if (!parsed?.success || !parsed.data?.user) {
    return NextResponse.json({ success: false, error: 'session malformed' }, { status: 502 })
  }
  return NextResponse.json({ success: true, data: { user: parsed.data.user } })
}
