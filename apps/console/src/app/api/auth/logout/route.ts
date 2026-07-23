/**
 * Console → gateway auth proxy — logout (plan M5b.4 / P1.10.T10).
 *
 *   POST /api/auth/logout   → { ok: true }  (clears the cookie)
 *
 * Clears the session cookie. The gateway's logout is a no-op (stateless
 * token), so we don't need to forward; clearing the cookie here is what ends
 * the browser session. We forward anyway (best-effort) so a future server-side
 * session store stays consistent, but a gateway failure doesn't block the
 * local cookie clear.
 *
 * Method is POST (NOT DELETE) to match the client (`auth-client.tsx` posts)
 * and the gateway (`POST /api/v1/auth/logout`). App Router routes HTTP methods
 * to exported functions, so a route exporting only DELETE would 405 on the
 * client's POST — `logout()` swallows the rejection and the cookie is never
 * cleared, leaving the user logged in. Exporting POST keeps the contract
 * consistent across the three layers.
 *
 * App Router routes by file path: `api/auth/logout/route.ts` serves exactly
 * `/api/auth/logout`, so the browser fetch in `auth-client.tsx` resolves here
 * instead of 404'ing.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { resolveRunId } from '@/lib/run-id'
import { forwardSessionHeaders } from '@/lib/proxy-headers'
import { clearSessionCookie } from '@/lib/session'

export const runtime = 'nodejs'

/**
 * POST /api/auth/logout — clear the session cookie. The gateway's logout is a
 * no-op (stateless token), so we don't need to forward; clearing the cookie
 * here is what ends the browser session. We forward anyway (best-effort) so a
 * future server-side session store stays consistent, but a gateway failure
 * doesn't block the local cookie clear.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Best-effort forward; ignore the result — the cookie clear is the real
  // logout action for the browser.
  try {
    await fetch(`${gatewayUrl()}/api/v1/auth/logout`, {
      method: 'POST',
      headers: forwardSessionHeaders(req, resolveRunId(req.headers.get('x-run-id'))),
      cache: 'no-store',
    })
  } catch {
    // Gateway down — still clear the cookie locally so the browser logs out.
  }
  const res = NextResponse.json({ success: true, data: { ok: true } })
  clearSessionCookie(res.cookies)
  return res
}
