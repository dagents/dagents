import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { app } from '../app.js'

/**
 * Integration tests for gateway dev-mode SSO (plan M5b.4 / P1.4.T2).
 *
 * Drives the gateway via `app.request()` against the three auth endpoints +
 * the session middleware. Coverage:
 *  - POST /api/v1/auth/login: 200 + token on good creds; 401 on bad;
 *    503 when SSO not configured
 *  - GET /api/v1/auth/session: 200 + user with a valid token (cookie + bearer);
 *    401 without; 503 when not configured
 *  - POST /api/v1/auth/logout: always 200
 *  - REQUIRE_LOGIN=1 gates a non-public route with 401; a session cookie lets
 *    it through; /health + /api/v1/auth/* stay public
 *  - a forged/expired token is rejected
 *
 * Env is set per-test; the auth module reads env lazily (not at import), so
 * flipping `SSO_SESSION_SECRET` between tests takes effect immediately.
 */

const SECRET = 'a'.repeat(48) // ≥ 32 bytes
const GOOD_USER = 'admin'
const GOOD_PASS = 'devpass123'

beforeEach(() => {
  process.env.SSO_DEV_USERNAME = GOOD_USER
  process.env.SSO_DEV_PASSWORD = GOOD_PASS
  process.env.SSO_SESSION_SECRET = SECRET
  delete process.env.REQUIRE_LOGIN
})

afterEach(() => {
  delete process.env.SSO_DEV_USERNAME
  delete process.env.SSO_DEV_PASSWORD
  delete process.env.SSO_SESSION_SECRET
  delete process.env.REQUIRE_LOGIN
})

describe('POST /api/v1/auth/login', () => {
  it('returns a token + user on good credentials', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: GOOD_PASS }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { token: string; user: { sub: string } } }
    expect(body.success).toBe(true)
    expect(body.data.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(body.data.user.sub).toBe(GOOD_USER)
  })

  it('rejects a bad password with 401', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a bad username with 401', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: GOOD_PASS }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 503 when SSO is not configured (no secret)', async () => {
    delete process.env.SSO_SESSION_SECRET
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: GOOD_PASS }),
    })
    expect(res.status).toBe(503)
  })

  it('rejects a malformed body with 400', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x' }), // missing password
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/auth/session', () => {
  it('resolves the user from a Bearer token', async () => {
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: GOOD_PASS }),
    })
    const token = ((await login.json()) as { data: { token: string } }).data.token

    const res = await app.request('/api/v1/auth/session', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { user: { sub: string } } }
    expect(body.data.user.sub).toBe(GOOD_USER)
  })

  it('resolves the user from a session cookie', async () => {
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: GOOD_PASS }),
    })
    const token = ((await login.json()) as { data: { token: string } }).data.token

    const res = await app.request('/api/v1/auth/session', {
      method: 'GET',
      headers: { cookie: `mil_session=${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('returns 401 without a session', async () => {
    const res = await app.request('/api/v1/auth/session', { method: 'GET' })
    expect(res.status).toBe(401)
  })

  it('rejects a forged token (bad signature) with 401', async () => {
    // A token with a payload but a wrong signature.
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', iat: 0, exp: 9999999999 })).toString('base64url') + '.badsig'
    const res = await app.request('/api/v1/auth/session', {
      method: 'GET',
      headers: { authorization: `Bearer ${forged}` },
    })
    expect(res.status).toBe(401)
  })

  it('rejects an expired token with 401', async () => {
    // Mint a token whose exp is already in the past (negative ttl → exp < now).
    // `verifySession` enforces `Math.floor(Date.now()/1000) >= exp` → reject.
    // This pins the "sessions don't live forever" security property.
    const { signSession } = await import('../auth.js')
    const expired = signSession({ sub: GOOD_USER, name: GOOD_USER }, -1)
    const res = await app.request('/api/v1/auth/session', {
      method: 'GET',
      headers: { authorization: `Bearer ${expired}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/auth/logout', () => {
  it('always returns 200 ok', async () => {
    const res = await app.request('/api/v1/auth/logout', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { ok: boolean } }
    expect(body.data.ok).toBe(true)
  })
})

describe('REQUIRE_LOGIN session gate', () => {
  it('gates a non-public route with 401 when no session', async () => {
    process.env.REQUIRE_LOGIN = '1'
    // The dispatch proxy is a non-public route; with REQUIRE_LOGIN on + no
    // session it must 401 before dialing dispatch.
    const res = await app.request('/api/v1/dispatch/agents', { method: 'GET' })
    expect(res.status).toBe(401)
  })

  it('lets a non-public route through with a valid session cookie', async () => {
    process.env.REQUIRE_LOGIN = '1'
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: GOOD_PASS }),
    })
    const token = ((await login.json()) as { data: { token: string } }).data.token

    // A valid session must let the request through the auth gate.
    // The status depends on whether dispatch is running (200) or not (502),
    // but it must NOT be 401 (which would mean the gate blocked it).
    const res = await app.request('/api/v1/dispatch/agents', {
      method: 'GET',
      headers: { cookie: `mil_session=${token}` },
    })
    expect(res.status).not.toBe(401)
  })

  it('keeps /health public under REQUIRE_LOGIN', async () => {
    process.env.REQUIRE_LOGIN = '1'
    const res = await app.request('/health', { method: 'GET' })
    expect(res.status).toBe(200)
  })

  it('keeps /api/v1/auth/login reachable under REQUIRE_LOGIN', async () => {
    process.env.REQUIRE_LOGIN = '1'
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: GOOD_USER, password: GOOD_PASS }),
    })
    expect(res.status).toBe(200)
  })

  it('does not gate when REQUIRE_LOGIN is off (open dev posture)', async () => {
    // REQUIRE_LOGIN unset → the dispatch proxy is reachable without a session.
    // Status depends on whether dispatch is running (200) or not (502),
    // but it must NOT be 401 (which would mean the gate blocked it).
    const res = await app.request('/api/v1/dispatch/agents', { method: 'GET' })
    expect(res.status).not.toBe(401)
  })
})
