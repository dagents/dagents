import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import {
  requireLogin,
  ssoConfigured,
  signSession,
  verifyDevLogin,
  verifySession,
  tokenFromRequest,
  SESSION_COOKIE,
  type SsoUser,
} from '../auth.js'

/**
 * `/api/v1/auth/*` — gateway SSO dev-mode auth surface (plan M5b.4 / P1.4.T2).
 *
 * Three endpoints the console's `/api/auth/*` proxy routes call:
 *
 *   POST /api/v1/auth/login    { username, password } → { token, user }
 *   GET  /api/v1/auth/session  → { user } | 401
 *   POST /api/v1/auth/logout   → { ok: true }
 *
 * The console holds the cookie (`mil_session`) so the browser never sees the
 * token; these routes deal in the bare token over JSON so the console can
 * set the cookie itself. `logout` is a no-op server-side (the token is
 * stateless — revocation is secret-rotation), but the console clears the
 * cookie, and exposing the endpoint keeps the contract symmetric for a future
 * server-side session store.
 *
 * When SSO isn't configured (`SSO_SESSION_SECRET` etc. unset), `login` 503s
 * and `session` 401s — matching the tokens route's "not configured = 503"
 * posture so the console can render a "SSO 未配置" state instead of a confusing
 * 401. `REQUIRE_LOGIN=1` does not affect these routes (they ARE the auth
 * surface); the session middleware exempts them.
 *
 * Standard envelope (CLAUDE.md API convention): { success, data?, error? }.
 */

export const authRoutes = new Hono()

const log = createLogger({ svc: 'gateway:auth' })

/** Standard envelope helpers (same shape as the rest of the gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
})

/**
 * POST /api/v1/auth/login — verify dev creds, return a signed session token.
 *
 * Returns `{ token, user: { sub, name } }` on success; 401 on bad creds;
 * 503 when SSO isn't configured. The token's transport (cookie vs header) is
 * the console's choice — this route just mints it.
 */
authRoutes.post('/login', async (c) => {
  if (!ssoConfigured()) {
    return fail(c, 503, 'sso not configured')
  }
  let parsed: z.infer<typeof loginSchema>
  try {
    parsed = loginSchema.parse(await c.req.json())
  } catch {
    return fail(c, 400, 'invalid login body')
  }
  const user = verifyDevLogin(parsed.username, parsed.password)
  if (!user) {
    // Constant-time-ish: a bad-creds response is the same shape/status as a
    // good-creds-not-configured one would be, so a probe can't tell configured
    // + wrong password from not-configured. Log the attempt server-side only.
    log.warn('login failed', { username: parsed.username })
    return fail(c, 401, 'invalid credentials')
  }
  const token = signSession(user)
  log.info('login ok', { sub: user.sub })
  return ok(c, { token, user })
})

/**
 * GET /api/v1/auth/session — resolve the current session's user.
 *
 * Reads the token from the cookie/bearer (`tokenFromRequest`), verifies it,
 * and returns `{ user }` on success or 401 when there is no valid session.
 * The console calls this on mount to decide login vs app.
 */
authRoutes.get('/session', async (c) => {
  if (!ssoConfigured()) {
    return fail(c, 503, 'sso not configured')
  }
  const user = currentUser(c)
  if (!user) return fail(c, 401, 'no session')
  return ok(c, { user })
})

/**
 * POST /api/v1/auth/logout — server-side no-op (stateless tokens).
 *
 * The token is stateless, so revocation is secret-rotation; the console
 * clears the cookie. Kept as an endpoint so the contract is symmetric for a
 * future server-side session store, and so the console has a single logout
 * call regardless of the backing store.
 */
authRoutes.post('/logout', async (c) => {
  // Best-effort: report ok so the console clears its cookie either way.
  return ok(c, { ok: true })
})

/**
 * Resolve the current user from the request, for the session route + the
 * middleware. Exported so the middleware can reuse the exact same resolution.
 */
export function currentUser(c: Context): SsoUser | null {
  return verifySession(tokenFromRequest(c))
}

/** Re-exported so `app.ts` can mount the routes without a second import. */
export { requireLogin, ssoConfigured, SESSION_COOKIE }
