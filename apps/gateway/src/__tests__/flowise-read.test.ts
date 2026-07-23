import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'

/**
 * Integration test for the gateway → Flowise READ-only passthrough
 * (P1.9.T5 / P1.10.T5).
 *
 * Spins up a stub HTTP server that records what the gateway forwards to it,
 * points the gateway at that stub via FLOWISE_URL, and drives the gateway via
 * Hono's in-process `app.request()`.
 *
 * Coverage:
 * - GET /api/v1/chatflows forwards the path + Authorization: Bearer <key>
 * - GET /api/v1/chatflows/:id forwards verbatim, query string preserved
 * - GET /api/v1/executions?agentflowId=… forwards the query
 * - the caller's own authorization header is replaced by the gateway key
 * - a non-2xx upstream collapses to a sanitized 502 (no body/headers leaked)
 * - 503 when FLOWISE_API_KEY is unset (no 401 leaking the auth shape)
 * - 405 for non-GET methods
 * - non-allowlisted response headers are dropped (no upstream x-* leak)
 */

let stubServer: Server
let stubUrl = ''
let recorded: { lastReq: Request | null } = { lastReq: null }
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
    res.setHeader('x-internal', 'flowise-stub')
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.FLOWISE_URL = stubUrl
  process.env.FLOWISE_API_KEY = 'flowise-key-123'
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  delete process.env.FLOWISE_URL
  delete process.env.FLOWISE_API_KEY
})

afterEach(() => {
  recorded = { lastReq: null }
})

const recordedReq = (): Request | null => recorded.lastReq

describe('gateway flowise read passthrough', () => {
  it('forwards GET /api/v1/chatflows with the gateway key as Bearer', async () => {
    const res = await app.request('/api/v1/chatflows?type=AGENTFLOW', { method: 'GET' })
    expect(res.status).toBe(200)

    const upstream = recordedReq()
    expect(upstream).not.toBeNull()
    expect(upstream!.method).toBe('GET')
    expect(upstream!.url).toContain('/api/v1/chatflows')
    expect(upstream!.url).toContain('type=AGENTFLOW')
    expect(upstream!.headers.get('authorization')).toBe('Bearer flowise-key-123')
  })

  it('forwards GET /api/v1/chatflows/:id verbatim and preserves the query', async () => {
    const id = 'd87207fd-7a11-4d42-8580-2f03ca58e79d'
    const res = await app.request(`/api/v1/chatflows/${id}?page=1&limit=5`, { method: 'GET' })
    expect(res.status).toBe(200)

    const upstream = recordedReq()!
    expect(upstream.method).toBe('GET')
    expect(upstream.url).toBe(`${stubUrl}/api/v1/chatflows/${id}?page=1&limit=5`)
    expect(upstream.headers.get('authorization')).toBe('Bearer flowise-key-123')
  })

  it('forwards GET /api/v1/executions with agentflowId + state filters', async () => {
    const res = await app.request(
      '/api/v1/executions?agentflowId=abc&state=INPROGRESS&page=1&limit=10',
      { method: 'GET' },
    )
    expect(res.status).toBe(200)

    const upstream = recordedReq()!
    expect(upstream.url).toContain('/api/v1/executions')
    expect(upstream.url).toContain('agentflowId=abc')
    expect(upstream.url).toContain('state=INPROGRESS')
  })

  it('replaces the caller authorization header with the gateway key', async () => {
    // A browser-supplied Authorization (its own sk- token, or nothing) must NOT
    // reach Flowise — the gateway always sends the Flowise API key.
    const res = await app.request('/api/v1/chatflows', {
      method: 'GET',
      headers: { authorization: 'Bearer caller-sk-token' },
    })
    expect(res.status).toBe(200)
    expect(recordedReq()!.headers.get('authorization')).toBe('Bearer flowise-key-123')
  })

  it('drops hop-by-hop headers and does not forward host', async () => {
    const res = await app.request('/api/v1/chatflows', {
      method: 'GET',
      headers: { host: 'gateway.example', connection: 'keep-alive', 'proxy-authorization': 'secret' },
    })
    expect(res.status).toBe(200)
    const upstream = recordedReq()!
    expect(upstream.headers.get('host')).toBe(new URL(stubUrl).host)
    expect(upstream.headers.get('proxy-authorization')).toBeNull()
  })

  it('collapses a non-2xx upstream to a sanitized 502 (no body/headers leaked)', async () => {
    const saved = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'flowise-host-1234')
      res.writeHead(401)
      res.end(JSON.stringify({ message: 'Unauthorized', stack: 'at /src/…', db: 'postgres://u:p@host' }))
    }
    try {
      const res = await app.request('/api/v1/chatflows', { method: 'GET' })
      // 401 from Flowise is NOT surfaced as 401 — the key's shape stays hidden.
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream error', upstreamStatus: 401 })
      expect(JSON.stringify(body)).not.toContain('postgres://')
      expect(JSON.stringify(body)).not.toContain('stack')
      expect(res.headers.get('x-internal')).toBeNull()
    } finally {
      stubHandler = saved
    }
  })

  it('drops non-allowlisted response headers on success (no upstream x-* leak)', async () => {
    const saved = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-powered-by', 'flowise')
      res.setHeader('set-cookie', 'session=abc')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    }
    try {
      const res = await app.request('/api/v1/chatflows', { method: 'GET' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('x-powered-by')).toBeNull()
      expect(res.headers.get('set-cookie')).toBeNull()
    } finally {
      stubHandler = saved
    }
  })

  it('returns 503 when FLOWISE_API_KEY is unset (no 401 leaking the auth shape)', async () => {
    const saved = process.env.FLOWISE_API_KEY
    delete process.env.FLOWISE_API_KEY
    try {
      const res = await app.request('/api/v1/chatflows', { method: 'GET' })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'flowise api key not configured' })
      // the stub must not have been dialed
      expect(recordedReq()).toBeNull()
    } finally {
      process.env.FLOWISE_API_KEY = saved
    }
  })

  it('502s when Flowise is unreachable', async () => {
    const saved = process.env.FLOWISE_URL
    process.env.FLOWISE_URL = 'http://127.0.0.1:1' // reserved, nothing listens
    try {
      const res = await app.request('/api/v1/chatflows', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream unavailable' })
    } finally {
      process.env.FLOWISE_URL = saved
    }
  })

  it('returns 405 for non-GET methods', async () => {
    const res = await app.request('/api/v1/chatflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(405)
    expect(recordedReq()).toBeNull()
  })
})
