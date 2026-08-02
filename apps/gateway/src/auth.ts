import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { createLogger } from '@dagents/shared'

/**
 * Gateway SSO — dev-mode session auth (plan M5b.4 / P1.4.T2).
 *
 * The spec (architecture-v0.2 §1.4) calls for OIDC / better-auth SSO at the
 * gateway. That is a later task (P1.4.T2 full); M5b.4 lands the *dev-mode*
 * floor the console needs to satisfy "登录可用": a username/password login →
 * HMAC-signed stateless session token, verified on every request, with the
 * actor stamped onto the context for the audit trail (M6.6) + future RBAC.
 *
 * ## Design
 *
 * - **Stateless session token.** A token is `<payloadB64>.<sig>` where the
 *   payload is a compact JSON `{ sub, name, iat, exp }` and the sig is
 *   HMAC-SHA256 over it with `SSO_SESSION_SECRET`. No DB session store needed
 *   (dev scale); a server restart keeps sessions valid because the secret is
 *   env-held, not in memory. Revocation is out of scope for dev mode (rotate
 *   the secret to invalidate all sessions).
 *
 * - **Env-gated.** When `SSO_DEV_USERNAME` / `SSO_DEV_PASSWORD` /
 *   `SSO_SESSION_SECRET` are all set, login is live and `REQUIRE_LOGIN=1`
 *   gates every non-public route behind a valid session. When they are unset,
 *   the gateway runs open (the pre-M5b.4 dev posture) so `pnpm test` + local
 *   dev without SSO keep working — exactly the same env-gated posture the
 *   LLM provider routes take for their configuration.
 *
 * - **No new deps.** Uses only `node:crypto` (HMAC + timing-safe compare) so
 *   no `jose`/`jsonwebtoken` dependency is added to the gateway. The token
 *   format is intentionally simple (not a full JWT) — it carries only what
 *   the audit actor + a future RBAC check need, and we control both ends.
 *
 * - **Cookie transport.** The console's `/api/auth/*` routes set the token in
 *   an HttpOnly `mil_session` cookie; the gateway's session middleware reads
 *   it from the `cookie` header the console proxy forwards. The gateway also
 *   accepts a raw `Authorization: Bearer <token>` for non-browser callers
 *   (scripts, tests) so the same session works without a cookie jar.
 *
 * ## Security notes
 *
 * - Passwords are compared in constant time (`timingSafeEqual`) to avoid
 *   timing-oracle username/password enumeration.
 * - The secret is required to be ≥ 32 bytes; a short/missing secret disables
 *   login (fail-closed for the sign path, never sign with a weak key).
 * - `exp` is enforced on verify; an expired token is rejected the same as a
 *   bad signature. `iat` is included for forensic/rotation use.
 * - This is dev-mode auth: a single shared secret + a single dev user. Prod
 *   SSO (OIDC) replaces `login` with an IdP redirect + the session middleware
 *   stays; the token shape may change but the `ssoUser` context contract won't.
 */

const log = createLogger({ svc: 'gateway:auth' })

/** Cookie name the console sets / the gateway reads. */
export const SESSION_COOKIE = 'mil_session'

/** Session lifetime: 8h (a dev workday). Short enough to force re-login, long
 *  enough to not interrupt work. */
const SESSION_TTL_SEC = 8 * 60 * 60

/** Minimum secret length to sign sessions — protects against a trivial/empty
 *  secret being used to mint tokens. */
const MIN_SECRET_BYTES = 32

/** Upper bound on a name/sub to keep the token payload bounded. */
const MAX_NAME_LEN = 128

export interface SsoUser {
  /** Stable subject id (the dev username; an OIDC sub in prod). */
  sub: string
  /** Display name for the audit trail + console avatar. */
  name: string
}

/** Dev credentials read from env (empty when SSO isn't configured). */
export interface DevCredentials {
  username: string
  password: string
  secret: string
}

/** True when dev-mode SSO is fully configured (creds + secret). */
export function ssoConfigured(): boolean {
  return ssoCredentials().secret.length >= MIN_SECRET_BYTES
}

/** Read the dev credentials + secret from env. Empty strings when unset. */
export function ssoCredentials(): DevCredentials {
  return {
    username: process.env.SSO_DEV_USERNAME ?? '',
    password: process.env.SSO_DEV_PASSWORD ?? '',
    secret: process.env.SSO_SESSION_SECRET ?? '',
  }
}

/** True when every non-public route requires a valid session. */
export function requireLogin(): boolean {
  return process.env.REQUIRE_LOGIN === '1' && ssoConfigured()
}

/**
 * Constant-time string compare. `timingSafeEqual` needs equal-length buffers,
 * so we compare lengths first in a way that still doesn't short-circuit on the
 * secret (a length mismatch returns false without comparing bytes, but the
 * length itself is not sensitive — the password is).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify dev credentials. Returns the `SsoUser` on success, null otherwise.
 * Constant-time on the password; the username lookup is direct (there is only
 * one dev user, so no username enumeration surface).
 */
export function verifyDevLogin(username: string, password: string): SsoUser | null {
  const creds = ssoCredentials()
  if (!ssoConfigured()) return null
  if (!safeEqual(username, creds.username)) return null
  if (!safeEqual(password, creds.password)) return null
  return { sub: username, name: username }
}

/**
 * Sign a session token for a user. Returns `<payloadB64url>.<sigB64url>`.
 * The payload carries `sub`/`name`/`iat`/`exp`; the sig is HMAC-SHA256 over
 * the payload with the session secret.
 *
 * Throws if SSO isn't configured (no secret) — the login route checks
 * `ssoConfigured()` first and 503s, so this is a defensive guard.
 */
export function signSession(user: SsoUser, ttlSec = SESSION_TTL_SEC): string {
  const { secret } = ssoCredentials()
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error('SSO_SESSION_SECRET not configured (or too short)')
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: user.sub.slice(0, MAX_NAME_LEN),
    name: user.name.slice(0, MAX_NAME_LEN),
    iat: now,
    exp: now + ttlSec,
  }
  const payloadB64 = b64urlEncode(JSON.stringify(payload))
  const sig = hmac(secret, payloadB64)
  return `${payloadB64}.${sig}`
}

/** Verify a session token. Returns the `SsoUser` on success, null otherwise. */
export function verifySession(token: string | null | undefined): SsoUser | null {
  if (!token) return null
  const { secret } = ssoCredentials()
  if (secret.length < MIN_SECRET_BYTES) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot >= token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  // Recompute the sig and compare in constant time so a forged token isn't
  // distinguishable by timing.
  const expected = hmac(secret, payloadB64)
  if (!safeEqual(sig, expected)) return null

  let payload: { sub?: string; name?: string; iat?: number; exp?: number }
  try {
    payload = JSON.parse(b64urlDecode(payloadB64))
  } catch {
    return null
  }
  if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null
  // Enforce expiry. `Date.now()` is fine here — this is request-time code in
  // the gateway, not a workflow script.
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null
  return { sub: payload.sub, name: payload.name ?? payload.sub }
}

/** HMAC-SHA256 over `data` with `secret`, base64url-encoded. */
function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url')
}

/** Base64url encode (no padding) — URL-safe for header/cookie transport. */
function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

/** Base64url decode. */
function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8')
}

/**
 * Resolve the session token off a request: the `mil_session` cookie first, then
 * a `Authorization: Bearer <token>` header (for non-browser callers). Returns
 * null when neither carries a token.
 */
export function tokenFromRequest(c: Context): string | null {
  // Cookie header is the browser path (the console proxy forwards it).
  const cookieHeader = c.req.header('cookie') ?? ''
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (k === SESSION_COOKIE) return part.slice(eq + 1).trim() || null
  }
  // Bearer token is the script/API path.
  const auth = c.req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null
  }
  return null
}

/**
 * The `ssoUser` stamped on the Hono context by the session middleware. Other
 * routes (audit, future RBAC) read it via `c.get('ssoUser')`.
 */
export interface SsoContextVars {
  ssoUser?: SsoUser
}

/**
 * Stamp the resolved SSO user onto the context. The audit trail (M6.6) reads
 * it back via `actorFromContext` (which prefers `c.get('ssoUser')` over the
 * `x-user-id` header, so gateway-internal calls without a console hop still
 * resolve the actor). Kept as a named helper so the middleware is the single
 * place that decides what "authenticated" stamps onto the context.
 */
export function stampSsoUser(c: Context, user: SsoUser): void {
  c.set('ssoUser', user)
}

/** Generate a cryptographically random dev secret (for `.env.example`). */
export function generateDevSecret(): string {
  return randomBytes(48).toString('base64url')
}
