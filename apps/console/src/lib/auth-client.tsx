/**
 * Browser-side auth client + session provider (plan M5b.4 / P1.10.T10).
 *
 * The console's login page + layout gate talk to the console's own `/api/auth/*`
 * proxy routes (which forward to the gateway). This module owns:
 *   - `fetchSession` / `login` / `logout` — thin fetch wrappers over those
 *     routes, mirroring the other data clients (`tokens-client.ts`)
 *   - `SessionProvider` + `useSession` — a React context the layout wraps the
 *     app in, so every page can read the current user + trigger a redirect to
 *     /login when `REQUIRE_LOGIN` is on and there is no session.
 *
 * The provider is intentionally minimal: it fetches `/api/auth/session` on
 * mount, holds `{ user, status }`, and exposes a `refresh()` for the login
 * page to call after a successful login. It does NOT gate routing itself —
 * the layout decides redirect-vs-render from `status`; the provider just
 * supplies the facts.
 */

'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/** The session user the browser renders (sub + display name). */
export interface AuthUser {
  sub: string
  name: string
}

/** Session fetch states. `loading` is the initial mount state. */
export type SessionStatus = 'loading' | 'authed' | 'unauthed' | 'error'

interface SessionContextValue {
  user: AuthUser | null
  status: SessionStatus
  /** Re-fetch /api/auth/session (e.g. after login). */
  refresh: () => Promise<void>
  /** Log out (clears the cookie) and refresh. */
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * GET /api/auth/session → the current user, or throws on a non-2xx (the
 * provider treats 401 as `unauthed`, not an error). Kept as a standalone
 * function so the login page can call it after a successful login.
 */
export async function fetchSession(): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/session', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
  })
  if (res.status === 401 || res.status === 503) return null
  if (!res.ok) throw new Error(`session check failed (${res.status})`)
  const body = (await res.json()) as Envelope<{ user: AuthUser }>
  if (!body.success || !body.data?.user) return null
  return body.data.user
}

/** POST /api/auth/login → the user on success; throws carrying `error` on failure. */
export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'include',
  })
  const body = (await res.json().catch(() => null)) as Envelope<{ user: AuthUser }> | null
  if (!res.ok || !body?.success || !body.data?.user) {
    throw new Error(body?.error ?? `login failed (${res.status})`)
  }
  return body.data.user
}

/** POST /api/auth/logout → clears the cookie. Never throws (best-effort). */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
}

/**
 * Provide the session to a subtree. Fetches `/api/auth/session` on mount and
 * exposes `{ user, status, refresh, logout }`. The layout reads `status` to
 * decide redirect-to-login vs render-the-app.
 */
export function SessionProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<SessionStatus>('loading')

  const refresh = useCallback(async () => {
    setStatus('loading')
    try {
      const u = await fetchSession()
      setUser(u)
      setStatus(u ? 'authed' : 'unauthed')
    } catch {
      // A network error is `error`, not `unauthed` — the latter is a definite
      // "no session" (401/503), the former is "couldn't tell".
      setStatus('error')
    }
  }, [])

  const doLogout = useCallback(async () => {
    await logout()
    setUser(null)
    setStatus('unauthed')
  }, [])

  // Fetch the session once on mount. `refresh` is stable, so this runs once.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo<SessionContextValue>(
    () => ({ user, status, refresh, logout: doLogout }),
    [user, status, refresh, doLogout],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/** Read the session context. Throws if used outside a provider (programmer error). */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
