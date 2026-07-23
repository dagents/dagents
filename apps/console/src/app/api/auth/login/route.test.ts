import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

/**
 * Integration tests for the console auth login proxy route (M5b.4 / P1.10.T10).
 *
 * Mirrors the other console route tests: `GATEWAY_URL` is repointed at a stub
 * HTTP server per test, and we assert the route's cookie handling + envelope
 * pass-through. Coverage:
 *  - POST /api/auth/login: 200 sets `mil_session` cookie + returns `{ user }`
 *    (NOT the token); 401 passes through without touching the cookie; 502 when
 *    the gateway is unreachable.
 *
 * NOTE on what this tests vs. doesn't: this calls the exported `POST` handler
 * directly, so it verifies the forward/cookie logic but NOT that Next.js routes
 * `/api/auth/login` to this file. That routing-structure guarantee is covered
 * by `apps/console/src/app/api/auth/auth-routing.test.ts`, which asserts the
 * three sub-path route files exist (and no single `route.ts` shadows them) and
 * cross-checks `next build`'s app-paths-manifest when present.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let stub: Server | null = null

async function withStub(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<void> {
  stub = createServer(handler)
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve))
  const addr = stub.address() as AddressInfo
  process.env.GATEWAY_URL = `http://127.0.0.1:${addr.port}`
}

afterEach(async () => {
  if (stub) {
    await new Promise<void>((r) => stub!.close(() => r()))
    stub = null
  }
  delete process.env.GATEWAY_URL
})

function jsonReq(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body !== undefined ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined,
  })
}

describe('POST /api/auth/login', () => {
  it('sets the mil_session cookie and returns { user } (not the token) on 200', async () => {
    let receivedPath = ''
    let receivedMethod = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      receivedMethod = req.method ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { token: 'tok-abc', user: { sub: 'admin', name: 'admin' } } }))
    })

    const res = await POST(jsonReq('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'x' } }))
    expect(res.status).toBe(200)
    // The route forwards to the gateway's login sub-path, not the bare /auth.
    expect(receivedPath).toBe('/api/v1/auth/login')
    expect(receivedMethod).toBe('POST')
    const body = (await res.json()) as { success: boolean; data: { user: { sub: string } } }
    expect(body.data.user.sub).toBe('admin')
    // The token must NOT be in the response body — it lives only in the cookie.
    expect(JSON.stringify(body)).not.toContain('tok-abc')
    // The cookie is set, HttpOnly.
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('mil_session=tok-abc')
    expect(setCookie.toLowerCase()).toContain('httponly')
  })

  it('passes a 401 through without setting a cookie', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(401)
      res.end(JSON.stringify({ success: false, error: 'invalid credentials' }))
    })

    const res = await POST(jsonReq('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } }))
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await POST(jsonReq('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'x' } }))
    expect(res.status).toBe(502)
  })
})
