import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'

/**
 * Integration test for the gateway → dispatch proxy (M2.9b / P1.9).
 *
 * Spins up a stub HTTP server that records what the gateway forwards to it,
 * points the gateway at that stub via DISPATCH_URL, and drives the gateway
 * via Hono's in-process `app.request()` — no supertest, no real port.
 *
 * Coverage:
 * - GET /api/v1/dispatch/tasks/:id forwards path + method unchanged
 * - POST /api/v1/dispatch/invoke passes the body through verbatim
 * - dispatch 5xx → gateway responds 502 sanitized (no body/headers leaked)
 * - hop-by-hop headers are not forwarded
 * - caller-supplied x-run-id is forwarded (we don't generate one)
 */

let stubServer: Server
let stubUrl = ''
// latest upstream request the stub received; the handler writes to it and
// each test reads it back via `recordedReq()`.
let recorded: { lastReq: Request | null } = { lastReq: null }
// swappable handler so 5xx / leak tests can override the stub's behavior.
type StubHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
let stubHandler: StubHandler = (req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    recorded.lastReq = new Request(
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'stub'}`),
      { method: req.method, headers: req.headers as Record<string, string>, body: raw || undefined },
    )
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-upstream', 'dispatch-stub')
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, path: req.url, echoedRunId: req.headers['x-run-id'] ?? null }))
  })
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.DISPATCH_URL = stubUrl
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
})

afterEach(() => {
  recorded = { lastReq: null }
})

const recordedReq = (): Request | null => recorded.lastReq

describe('gateway dispatch proxy', () => {
  it('forwards GET /api/v1/dispatch/tasks/:id with path + method unchanged', async () => {
    const res = await app.request('/api/v1/dispatch/tasks/abc-123/messages?limit=10', {
      method: 'GET',
      headers: { host: 'gateway' },
    })
    expect(res.status).toBe(200)

    const upstream = recordedReq()
    expect(upstream).not.toBeNull()
    expect(upstream!.method).toBe('GET')
    expect(upstream!.url).toContain('/api/v1/dispatch/tasks/abc-123/messages')
    expect(upstream!.url).toContain('limit=10')
  })

  it('passes the POST /api/v1/dispatch/invoke body through verbatim', async () => {
    const payload = { taskId: 't-1', input: { question: 'hi' } }
    const res = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    const upstream = recordedReq()
    expect(upstream).not.toBeNull()
    expect(upstream!.method).toBe('POST')
    expect(upstream!.url).toContain('/api/v1/dispatch/invoke')
    expect(await upstream!.text()).toBe(JSON.stringify(payload))
  })

  it('forwards a caller-supplied x-run-id without generating one', async () => {
    const res = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': 'caller-run-7' },
      body: JSON.stringify({ taskId: 't-1' }),
    })
    expect(res.status).toBe(200)
    // forwarded to dispatch...
    expect(recordedReq()?.headers.get('x-run-id')).toBe('caller-run-7')
    // ...and not echoed by the gateway (dispatch owns run ids, unlike flows)
    expect(res.headers.get('x-run-id')).toBeNull()
  })

  it('does not inject an x-run-id when the caller omits it', async () => {
    const res = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 't-1' }),
    })
    expect(res.status).toBe(200)
    // the gateway must not fabricate a run-id for dispatch (no UUID echoed)
    expect(res.headers.get('x-run-id')).toBeNull()
    expect(recordedReq()?.headers.get('x-run-id')).toBeNull()
  })

  it('collapses a dispatch 5xx to a sanitized 502 (no body/headers leaked)', async () => {
    const savedHandler = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'dispatch-host-1234')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /src/dispatch/…', db: 'postgres://u:p@host' }))
    }
    try {
      const res = await app.request('/api/v1/dispatch/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 't-1' }),
      })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream error', upstreamStatus: 500 })
      // the leaky upstream body/headers must NOT reach the client
      expect(JSON.stringify(body)).not.toContain('stack')
      expect(JSON.stringify(body)).not.toContain('postgres://')
      expect(res.headers.get('x-internal')).toBeNull()
    } finally {
      stubHandler = savedHandler
    }
  })

  it('502s when dispatch is unreachable', async () => {
    const saved = process.env.DISPATCH_URL
    process.env.DISPATCH_URL = 'http://127.0.0.1:1' // reserved, nothing listens
    try {
      const res = await app.request('/api/v1/dispatch/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 't-1' }),
      })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream unavailable' })
    } finally {
      process.env.DISPATCH_URL = saved
    }
  })

  it('drops hop-by-hop headers and does not forward host', async () => {
    const res = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'gateway.example',
        connection: 'keep-alive',
        'proxy-authorization': 'secret',
      },
      body: JSON.stringify({ taskId: 't-1' }),
    })
    expect(res.status).toBe(200)
    const upstream = recordedReq()!
    // hop-by-hop + client host dropped; undici sets its own host for the upstream URL
    expect(upstream.headers.get('host')).toBe(new URL(stubUrl).host)
    expect(upstream.headers.get('proxy-authorization')).toBeNull()
    // client content-length is dropped; undici recomputes it from the buffered body
    expect(upstream.headers.get('content-length')).toBe(String(JSON.stringify({ taskId: 't-1' }).length))
  })

  it('strips fields named in the Connection header (RFC 7230 §6.1)', async () => {
    const res = await app.request('/api/v1/dispatch/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'x-sneaky, keep-alive',
        'x-sneaky': 'payload',
      },
      body: JSON.stringify({ taskId: 't-1' }),
    })
    expect(res.status).toBe(200)
    expect(recordedReq()?.headers.get('x-sneaky')).toBeNull()
  })

  it('drops non-allowlisted response headers on success (no upstream x-* leak)', async () => {
    const savedHandler = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'leak-me')
      res.setHeader('x-powered-by', 'dispatch')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    }
    try {
      const res = await app.request('/api/v1/dispatch/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 't-1' }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('x-internal')).toBeNull()
      expect(res.headers.get('x-powered-by')).toBeNull()
    } finally {
      stubHandler = savedHandler
    }
  })

  it('forwards a dispatch 4xx status but sanitizes the body (no internal leak)', async () => {
    // Spec: 4xx 状态码原样转发（让 console 能区分 "bad input" vs "dispatch down"），
    // 但 body 需 sanitized — 不转发上游原始 body（可能含 DB 连接串等内部信息）。
    // 5xx 仍然折叠为 502。
    const savedHandler = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'dispatch-host')
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'task not found', internal: 'postgres://u:p@host' }))
    }
    try {
      const res = await app.request('/api/v1/dispatch/tasks/t-1', { method: 'GET' })
      // 4xx 状态码原样转发
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream client error', upstreamStatus: 404 })
      // 内部信息不泄露
      expect(JSON.stringify(body)).not.toContain('postgres://')
      expect(JSON.stringify(body)).not.toContain('task not found')
      // 内部 header 不泄露
      expect(res.headers.get('x-internal')).toBeNull()
    } finally {
      stubHandler = savedHandler
    }
  })
})
