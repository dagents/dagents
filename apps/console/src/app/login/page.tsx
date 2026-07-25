'use client'

/**
 * Login page (plan M5b.4 / P1.10.T10).
 *
 * The console's SSO entry point. The browser hits `/login` when the
 * SessionProvider detects no session + `REQUIRE_LOGIN` is on (the layout
 * redirects). The page is a minimal username/password form that POSTs to the
 * console's `/api/auth/login` (→ gateway), and on success calls
 * `refresh()` so the SessionProvider flips to `authed` and the layout
 * re-renders into the app.
 *
 * Styling reuses the design's token CSS (shell/tokens) so the login page reads
 * as part of the console, not a generic form. Kept a server-route shell (`page.tsx`)
 * that just renders this client component, matching the other pages.
 */

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { login, useSession } from '@/lib/auth-client'

export default function LoginPage(): React.ReactElement {
  const router = useRouter()
  const { refresh } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await login(username, password)
      // Refresh the session context so the layout gate flips to authed, then
      // push to the home route. The layout's redirect-on-authed handles the
      // case where the user navigated to /login while already authed too.
      await refresh()
      router.push('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">DAgent</div>
            <div className="brand-sub">控制台登录</div>
          </div>
        </div>
        <label className="login-field">
          <span>用户名</span>
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="login-field">
          <span>密码</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error ? <div className="login-error" role="alert">{error}</div> : null}
        <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="muted login-hint">
          通过 gateway SSO 验证（dev 模式：SSO_DEV_USERNAME / SSO_DEV_PASSWORD）。
        </p>
      </form>
    </div>
  )
}
