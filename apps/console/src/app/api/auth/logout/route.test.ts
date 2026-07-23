import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

/**
 * Integration test for the console auth logout proxy route (M5b.4 / P1.10.T10).
 *
 * Coverage:
 *  - POST /api/auth/logout: always 200 + clears the cookie (even if the
 *    gateway is down). Pins the method as POST (the client posts, the gateway
 *    posts) — a route exporting only DELETE would 405 on the client's POST and
 *    `logout()` would swallow it, leaving the cookie set.
 *
 * See `login/route.test.ts` for the note on what direct-handler tests cover vs.
 * the routing-structure guarantee in `auth-routing.test.ts`.
 */

function jsonReq(path: string, init: { method: string; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('POST /api/auth/logout', () => {
  // afterEach not needed (logout uses a dead port; no stub to close), but keep
  // the env clean in case a future test sets it.
  afterEach(() => {
    delete process.env.GATEWAY_URL
  })

  it('clears the mil_session cookie and returns 200 even when the gateway is down', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await POST(jsonReq('/api/auth/logout', { method: 'POST' }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    // maxAge=0 clears the cookie.
    expect(setCookie).toContain('mil_session=')
    expect(setCookie.toLowerCase()).toContain('max-age=0')
  })

  it('uses POST (matches the client fetch + gateway /api/v1/auth/logout)', async () => {
    // Pin the exported handler is POST, not DELETE — a DELETE-only route would
    // 405 the client's POST and silently fail to log out.
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await POST(jsonReq('/api/auth/logout', { method: 'POST' }))
    expect(res.status).toBe(200)
  })
})
