import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'

/**
 * Integration test for the gateway → Flowise proxy.
 *
 * Spins up a stub HTTP server that records what the gateway forwards to it,
 * points the gateway at that stub via FLOWISE_URL, and drives the gateway
 * via Hono's in-process `app.request()` — no supertest, no real port.
 *
 * Coverage:
 * - rewrites /api/v1/flows/<id>/prediction → /api/v1/prediction/<id>
 * - forwards method, query, JSON body
 * - injects x-run-id when the caller omits it; preserves a caller-supplied id
 * - echoes x-run-id on the response
 * - 404s for unsupported flow paths (no open proxy)
 * - 502s when Flowise is unreachable
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
    res.setHeader('x-upstream', 'flowise-stub')
    res.writeHead(200)
    res.end(JSON.stringify({ text: 'hello from agent', echoedRunId: req.headers['x-run-id'] }))
  })
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.FLOWISE_URL = stubUrl
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
})

afterEach(() => {
  recorded = { lastReq: null }
})

const recordedReq = (): Request | null => recorded.lastReq

describe('gateway flow proxy', () => {
  it('rewrites POST /api/v1/flows/:id/prediction → /api/v1/prediction/:id and forwards body/query', async () => {
    const res = await app.request(
      '/api/v1/flows/d87207fd-7a11-4d42-8580-2f03ca58e79d/prediction?overrideConfig=%7B%7D',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'gateway' },
        body: JSON.stringify({ question: 'hi', history: [] }),
      },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello from agent', echoedRunId: expect.any(String) })

    const upstream = recordedReq()
    expect(upstream).not.toBeNull()
    expect(upstream!.method).toBe('POST')
    expect(upstream!.url).toContain('/api/v1/prediction/d87207fd-7a11-4d42-8580-2f03ca58e79d')
    expect(upstream!.url).toContain('overrideConfig=%7B%7D')
    expect(await upstream!.text()).toBe(JSON.stringify({ question: 'hi', history: [] }))
  })

  // shared UUID for the "id-shaped" tests below — `abc` no longer matches the
  // tightened UUID regex.
  const ID = '11111111-1111-4111-8111-111111111111'

  it('injects x-run-id when the caller omits it', async () => {
    const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x' }),
    })
    expect(res.status).toBe(200)
    const rid = res.headers.get('x-run-id')
    expect(rid).toBeTruthy()
    expect(rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(recordedReq()?.headers.get('x-run-id')).toBe(rid)
  })

  it('preserves a caller-supplied x-run-id and echoes it back', async () => {
    const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': 'run-42' },
      body: JSON.stringify({ question: 'x' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-run-id')).toBe('run-42')
    expect(recordedReq()?.headers.get('x-run-id')).toBe('run-42')
  })

  it('404s for unsupported flow paths (no open proxy)', async () => {
    const res = await app.request('/api/v1/flows/abc/chatflows', { method: 'GET' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toMatchObject({ success: false })
    expect(recordedReq()).toBeNull()
  })

  it('502s when Flowise is unreachable', async () => {
    const saved = process.env.FLOWISE_URL
    process.env.FLOWISE_URL = 'http://127.0.0.1:1' // reserved, nothing listens
    try {
      const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'x' }),
      })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream unavailable' })
    } finally {
      process.env.FLOWISE_URL = saved
    }
  })

  it('drops hop-by-hop headers and does not forward host', async () => {
    const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'gateway.example',
        connection: 'keep-alive',
        'proxy-authorization': 'secret',
      },
      body: JSON.stringify({ question: 'x' }),
    })
    expect(res.status).toBe(200)
    const upstream = recordedReq()!
    // hop-by-hop + client host dropped; undici sets its own host for the upstream URL
    expect(upstream.headers.get('host')).toBe(new URL(stubUrl).host)
    expect(upstream.headers.get('proxy-authorization')).toBeNull()
    // client content-length is dropped; undici recomputes it from the buffered body
    expect(upstream.headers.get('content-length')).toBe(String(JSON.stringify({ question: 'x' }).length))
    // response drops hop-by-hop but keeps content-type + x-run-id
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('x-run-id')).toBeTruthy()
  })

  it('rejects a non-UUID chatflow id (no garbage forwarded upstream)', async () => {
    const res = await app.request('/api/v1/flows/not-a-uuid/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ success: false })
    expect(recordedReq()).toBeNull()
  })

  it('falls back to a generated x-run-id when the caller sends an empty/whitespace value', async () => {
    const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-id': '   ' },
      body: JSON.stringify({ question: 'x' }),
    })
    expect(res.status).toBe(200)
    const rid = res.headers.get('x-run-id')
    expect(rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(rid).toBe(recordedReq()?.headers.get('x-run-id'))
  })

  it('strips fields named in the Connection header (RFC 7230 §6.1)', async () => {
    const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'x-sneaky, keep-alive',
        'x-sneaky': 'payload',
      },
      body: JSON.stringify({ question: 'x' }),
    })
    expect(res.status).toBe(200)
    expect(recordedReq()?.headers.get('x-sneaky')).toBeNull()
  })

  it('sanitizes an upstream application 5xx (no body/headers leaked)', async () => {
    const savedHandler = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'flowise-host-1234')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /src/flowise/…', db: 'postgres://u:p@host' }))
    }
    try {
      const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'x' }),
      })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream error', upstreamStatus: 500 })
      // the leaky upstream body/headers must NOT reach the client
      expect(JSON.stringify(body)).not.toContain('stack')
      expect(JSON.stringify(body)).not.toContain('postgres://')
      expect(res.headers.get('x-internal')).toBeNull()
      expect(res.headers.get('x-run-id')).toBeTruthy()
    } finally {
      stubHandler = savedHandler
    }
  })

  it('drops non-allowlisted response headers on success (no upstream x-* leak)', async () => {
    const savedHandler = stubHandler
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'leak-me')
      res.setHeader('x-powered-by', 'flowise')
      res.writeHead(200)
      res.end(JSON.stringify({ text: 'ok' }))
    }
    try {
      const res = await app.request(`/api/v1/flows/${ID}/prediction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'x' }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('x-internal')).toBeNull()
      expect(res.headers.get('x-powered-by')).toBeNull()
      expect(res.headers.get('x-run-id')).toBeTruthy()
    } finally {
      stubHandler = savedHandler
    }
  })
})
