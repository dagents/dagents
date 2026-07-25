'use client'

/**
 * Root auth gate (plan M5b.4 / P1.10.T10).
 *
 * Wraps the whole app in the session context + a login gate:
 *   - `SessionProvider` — resolves the current user (or `unauthed`) on mount.
 *   - a login gate: when `REQUIRE_LOGIN` is on and the session is `unauthed`,
 *     redirect to `/login` instead of rendering the app. The login page itself
 *     is exempt (it must render to collect creds). `loading` renders nothing
 *     (avoids a flash of the app or a premature redirect).
 *
 * This is a client component (`'use client'`) so it can use the session
 * context + `usePathname`. It provides the SessionProvider + login gate only;
 * the layout shell is rendered by `ChatLayout` (wrapped around the gate's
 * children in `app/layout.tsx`), so the shell only renders for authed users.
 *
 * `REQUIRE_LOGIN` is read from `NEXT_PUBLIC_REQUIRE_LOGIN` (a client-visible
 * env) so the gate can run client-side without a round-trip. Default off →
 * dev without SSO stays open (the app renders for everyone, matching the
 * pre-M5b.4 posture).
 *
 * run_id: the per-page browser→console run id is NOT minted here. The M5b.4
 * acceptance bar ("所有请求带 run_id") is met server-side — every console
 * proxy route calls `resolveRunId(...)` which forwards a caller `x-run-id` or
 * mints one, so the console→gateway hop always carries one regardless of
 * whether the browser sent one. A client-side per-page id would only matter
 * for correlating a page's *browser→console* hops under one id, and the data
 * clients would have to opt in (`useConsoleFetch`) for it to take effect;
 * that is a follow-up, not part of this gate.
 */

import { useEffect, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { SessionProvider, useSession } from '@/lib/auth-client'

/** Client-visible: when '1', the app requires a session (redirects to /login). */
const REQUIRE_LOGIN = process.env.NEXT_PUBLIC_REQUIRE_LOGIN === '1'

function Gate({ children }: { children: ReactNode }): React.ReactElement {
  const { status } = useSession()
  const pathname = usePathname() ?? '/'
  const router = useRouter()

  useEffect(() => {
    // Only redirect when login is required AND we're sure there's no session.
    // `loading` is inconclusive — wait. The login page is always allowed.
    const isLoginPage = pathname === '/login'
    if (REQUIRE_LOGIN && status === 'unauthed' && !isLoginPage) {
      router.replace('/login')
    }
    // If already authed and sitting on /login (e.g. after login), push home.
    if (status === 'authed' && isLoginPage) {
      router.replace('/')
    }
  }, [status, pathname, router])

  // While loading, render nothing — avoids a flash of the app (which would
  // trigger data fetches before the session is known) or a flash of /login.
  if (status === 'loading') return <></>

  // The login page renders its own (non-shell) layout; everything else is
  // rendered as-is so the wrapping `ChatLayout` (in app/layout.tsx) becomes
  // the layout. Unauthed users hitting a non-/login page see nothing until
  // the redirect fires (above).
  if (pathname === '/login') return <>{children}</>
  if (REQUIRE_LOGIN && status !== 'authed') return <></>

  return <>{children}</>
}

export function RootGate({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  )
}
