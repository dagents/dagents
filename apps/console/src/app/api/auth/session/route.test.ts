import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

/**
 * Integration tests for the console auth session proxy route (M5b.4 / P1.10.T10).
 *
 * Coverage:
 *  - GET /api/auth/session: forwards the cookie to the gateway; 200 → user,
 *    401 → 401.
 *
 * See `login/route.test.ts` for the note on what direct-handler tests cover vs.
 * the routing-structure guarantee in `auth-routing.test.ts`.
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

describe('GET /api/auth/session', () => {
  it('forwards the cookie and returns the user on 200', async () => {
    let receivedCookie = ''
    let receivedPath = ''
    await withStub((req, res) => {
      receivedCookie = req.headers['cookie'] ?? ''
      receivedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { user: { sub: 'admin', name: 'admin' } } }))
    })

    const res = await GET(jsonReq('/api/auth/session', { method: 'GET', headers: { cookie: 'mil_session=tok-abc' } }))
    expect(res.status).toBe(200)
    expect(receivedPath).toBe('/api/v1/auth/session')
    expect(receivedCookie).toContain('mil_session=tok-abc')
    const body = (await res.json()) as { success: boolean; data: { user: { sub: string } } }
    expect(body.data.user.sub).toBe('admin')
  })

  it('passes a 401 through when there is no session', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(401)
      res.end(JSON.stringify({ success: false, error: 'no session' }))
    })

    const res = await GET(jsonReq('/api/auth/session', { method: 'GET' }))
    expect(res.status).toBe(401)
  })
})
