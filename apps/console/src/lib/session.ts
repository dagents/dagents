/**
 * Console session config + cookie helpers (plan M5b.4 / P1.10.T10).
 *
 * The console's `/api/auth/*` routes proxy the gateway's `/api/v1/auth/*` and
 * hold the session token in an HttpOnly cookie (`mil_session`) so the browser
 * never sees it. This module owns the cookie name + the `Set-Cookie` attributes
 * so the login/logout/session routes stay small and the cookie policy is in
 * one place.
 *
 * `GATEWAY_URL` is the same server-side base the other proxy routes use
 * (`lib/config.ts`); the auth routes forward to `${gatewayUrl()}/api/v1/auth/*`.
 */

import type { ResponseCookies } from 'next/dist/server/web/spec-extension/cookies'

/** Cookie name — matches the gateway's `SESSION_COOKIE` (`auth.ts`). */
export const SESSION_COOKIE = 'mil_session'

/** Session cookie lifetime: 8h, mirroring the gateway's session TTL. */
const SESSION_MAX_AGE_SEC = 8 * 60 * 60

/**
 * Set the session cookie on a Next response. HttpOnly + SameSite=Lax + Secure
 * (in production) so the token can't be read by JS, isn't sent on cross-site
 * requests that aren't top-level navigations, and only travels over HTTPS in
 * prod. `Path=/` so it's sent to every console route.
 */
export function setSessionCookie(cookies: ResponseCookies, token: string): void {
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  })
}

/** Clear the session cookie (logout). Same attributes so the browser drops it. */
export function clearSessionCookie(cookies: ResponseCookies): void {
  cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}

/** Read the session token off a request's cookies (null when absent). */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || null
    }
  }
  return null
}

/** The public shape of a session user the browser + console routes use. */
export interface SessionUser {
  sub: string
  name: string
}
