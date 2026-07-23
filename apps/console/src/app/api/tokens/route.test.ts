import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as listGet, POST as createPost } from './route'
import { GET as itemGet, PUT as itemPut, DELETE as itemDelete } from './[id]/route'

/**
 * Integration tests for the `/api/tokens/*` gateway proxy routes (P1.10.T8).
 *
 * The routes are a thin forwarding layer: zod-free (the gateway validates),
 * but they must (a) keep the gateway URL server-side, (b) forward the right
 * method/path to `/api/v1/tokens/*`, (c) pass through the gateway's status +
 * body verbatim (including its sanitized 502/503), and (d) reject non-numeric
 * `:id` at the console edge so traversal never reaches the gateway.
 *
 * Pattern mirrors `api/chat/route.test.ts`: `GATEWAY_URL` is repointed at a
 * stub HTTP server (or a dead port) per test, and we assert what the stub
 * received + what the route returned.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let stub: Server | null = null
let stubUrl = ''
let recorded: { method: string; path: string; body: string; auth?: string; runId?: string } | null = null

/** Spin up a stub gateway on an ephemeral port and point the route at it. */
async function withStub(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<void> {
  recorded = null
  stub = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        auth: req.headers['authorization'] as string | undefined,
        runId: req.headers['x-run-id'] as string | undefined,
      }
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve))
  const addr = stub.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.GATEWAY_URL = stubUrl
}

afterEach(async () => {
  if (stub) {
    await new Promise<void>((r) => stub!.close(() => r()))
    stub = null
  }
  delete process.env.GATEWAY_URL
  recorded = null
})

function jsonReq(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  })
}

describe('GET /api/tokens (list)', () => {
  it('forwards to gateway /api/v1/tokens and returns the body verbatim', async () => {
    const payload = { success: true, data: { items: [{ id: 1, name: 'tok-a', key: 'AAAA****aaaa', group: 'default' }], total: 1 } }
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify(payload))
    })

    const res = await listGet(jsonReq('/api/tokens?p=0', { method: 'GET' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(payload)
    expect(recorded!.method).toBe('GET')
    expect(recorded!.path).toBe('/api/v1/tokens?p=0')
  })

  it('passes the gateway 502 (upstream error) through verbatim', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(502)
      res.end(JSON.stringify({ success: false, error: 'upstream error', upstreamStatus: 500 }))
    })

    const res = await listGet(jsonReq('/api/tokens', { method: 'GET' }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'upstream error' })
  })

  it('passes the gateway 503 (admin key not configured) through verbatim', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(503)
      res.end(JSON.stringify({ success: false, error: 'token admin not configured' }))
    })

    const res = await listGet(jsonReq('/api/tokens', { method: 'GET' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ success: false, error: 'token admin not configured' })
  })

  it('returns 502 gateway unavailable when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await listGet(jsonReq('/api/tokens', { method: 'GET' }))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ success: false, error: 'gateway unavailable' })
  })
})

describe('POST /api/tokens (create)', () => {
  it('forwards the body to gateway /api/v1/tokens and returns success', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })

    const body = { name: 'new-tok', remain_quota: 5000, meta: { remark: 'local' } }
    const res = await createPost(jsonReq('/api/tokens', { method: 'POST', body }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    // The body is forwarded verbatim — the gateway, not the console, splits `meta`.
    expect(recorded!.method).toBe('POST')
    expect(recorded!.path).toBe('/api/v1/tokens')
    expect(JSON.parse(recorded!.body)).toEqual(body)
  })
})

describe('GET /api/tokens/:id', () => {
  it('forwards to gateway /api/v1/tokens/:id', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { id: 42, name: 'tok-42', key: 'BBBB****bbbb' } }))
    })

    const res = await itemGet(jsonReq('/api/tokens/42', { method: 'GET' }), { params: Promise.resolve({ id: '42' }) })
    expect(res.status).toBe(200)
    expect(recorded!.path).toBe('/api/v1/tokens/42')
  })

  it('rejects a non-numeric id with 400 and never dials the gateway', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1' // dead port; a dial would 502, not 400
    const res = await itemGet(jsonReq('/api/tokens/not-a-number', { method: 'GET' }), { params: Promise.resolve({ id: 'not-a-number' }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'invalid token id' })
  })
})

describe('PUT /api/tokens/:id', () => {
  it('forwards the body to gateway /api/v1/tokens/:id', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })

    const body = { name: 'renamed', meta: { remark: 'prod' } }
    const res = await itemPut(jsonReq('/api/tokens/7', { method: 'PUT', body }), { params: Promise.resolve({ id: '7' }) })
    expect(res.status).toBe(200)
    expect(recorded!.method).toBe('PUT')
    expect(recorded!.path).toBe('/api/v1/tokens/7')
    expect(JSON.parse(recorded!.body)).toEqual(body)
  })

  it('rejects a non-numeric id with 400', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await itemPut(jsonReq('/api/tokens/abc', { method: 'PUT', body: { name: 'x' } }), { params: Promise.resolve({ id: 'abc' }) })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/tokens/:id', () => {
  it('forwards to gateway /api/v1/tokens/:id', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })

    const res = await itemDelete(jsonReq('/api/tokens/9', { method: 'DELETE' }), { params: Promise.resolve({ id: '9' }) })
    expect(res.status).toBe(200)
    expect(recorded!.method).toBe('DELETE')
    expect(recorded!.path).toBe('/api/v1/tokens/9')
  })

  it('rejects a non-numeric id with 400', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await itemDelete(jsonReq('/api/tokens/x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'x' }) })
    expect(res.status).toBe(400)
  })
})

describe('x-run-id forwarding', () => {
  it('forwards a well-formed x-run-id to the gateway', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })

    await listGet(jsonReq('/api/tokens', { method: 'GET', headers: { 'x-run-id': 'run-abc-123' } }))
    expect(recorded!.runId).toBe('run-abc-123')
  })

  // M5b.4: an over-length caller id is dropped, but the route now MINTS a
  // fresh UUID in its place (so every hop carries an x-run-id — the
  // "所有请求带 run_id" bar). The over-long value itself must NOT be forwarded;
  // the recorded id is a generated UUID, not the caller's garbage.
  it('replaces an over-long x-run-id with a generated UUID (never forwards the long value)', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })

    const tooLong = 'x'.repeat(200)
    await listGet(jsonReq('/api/tokens', { method: 'GET', headers: { 'x-run-id': tooLong } }))
    expect(recorded!.runId).not.toBe(tooLong)
    expect(recorded!.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  // M5b.4: an absent caller id is no longer forwarded as undefined — the route
  // mints a UUID so the gateway hop is always traceable.
  it('generates an x-run-id when the caller omits one', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })

    await listGet(jsonReq('/api/tokens', { method: 'GET' }))
    expect(recorded!.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
