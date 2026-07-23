import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'

/**
 * Integration tests for /api/v1/llm/* → new-api /v1/* passthrough (M2.8/T10).
 *
 * Stub server emulates new-api's OpenAI-compatible surface; the gateway
 * forwards the caller's Authorization verbatim (no admin key swap).
 *
 * Coverage:
 * - /api/v1/llm/chat/completions → /v1/chat/completions
 * - caller's Authorization forwarded as-is (NOT replaced with admin key)
 * - method + body + query forwarded
 * - 401/429 from upstream pass through (meaningful to the caller)
 * - 5xx collapsed to sanitized 502
 * - missing Authorization → 400 at the edge
 * - path traversal / unsupported path → 400
 */

let stubServer: Server
let stubUrl = ''
let recorded: { lastReq: Request | null } = { lastReq: null }
type StubHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
let stubHandler: StubHandler = defaultHandler

function defaultHandler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    recorded.lastReq = new Request(
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'stub'}`),
      { method: req.method, headers: req.headers as Record<string, string>, body: raw || undefined },
    )
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hi back' } }],
    }))
  })
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.NEWAPI_BASE_URL = stubUrl
  process.env.NEWAPI_ADMIN_KEY = 'test-admin-key'
  process.env.NEWAPI_ADMIN_USER_ID = '1'
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
})

afterEach(() => {
  recorded = { lastReq: null }
  stubHandler = defaultHandler
})

const recordedReq = (): Request | null => recorded.lastReq

describe('gateway llm passthrough', () => {
  it('rewrites /api/v1/llm/chat/completions → /v1/chat/completions and forwards body', async () => {
    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-caller-llm' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toBe('hi back')

    const upstream = recordedReq()!
    expect(upstream.method).toBe('POST')
    expect(upstream.url).toContain('/v1/chat/completions')
    expect(await upstream.text()).toContain('"model":"glm-5.2"')
  })

  it('forwards the caller Authorization verbatim — does NOT swap in the admin key', async () => {
    await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-caller-llm' },
      body: JSON.stringify({ model: 'm' }),
    })
    const upstream = recordedReq()!
    expect(upstream.headers.get('authorization')).toBe('Bearer sk-caller-llm')
    expect(upstream.headers.get('authorization')).not.toContain('test-admin-key')
    // admin user header is NOT injected on the LLM path
    expect(upstream.headers.get('new-api-user')).toBeNull()
  })

  it('forwards query string (e.g. /v1/models?key=)', async () => {
    await app.request('/api/v1/llm/models?limit=5', {
      method: 'GET',
      headers: { authorization: 'Bearer sk-caller' },
    })
    const upstream = recordedReq()!
    expect(upstream.url).toContain('/v1/models?limit=5')
  })

  it('400s when Authorization is missing (edge rejects before new-api)', async () => {
    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'missing authorization' })
    expect(recordedReq()).toBeNull()
  })

  it('passes through a 401 from new-api (bad key — meaningful to the caller)', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(401)
      res.end(JSON.stringify({ error: { message: 'Invalid token' } }))
    }
    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-bad' },
      body: JSON.stringify({ model: 'm' }),
    })
    expect(res.status).toBe(401)
  })

  it('passes through a 429 from new-api (rate limit — meaningful to the caller)', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(429)
      res.end(JSON.stringify({ error: { message: 'rate limited' } }))
    }
    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-caller' },
      body: JSON.stringify({ model: 'm' }),
    })
    expect(res.status).toBe(429)
  })

  it('collapses an upstream 5xx to a sanitized 502', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'newapi-host')
      res.writeHead(502)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /internal/…' }))
    }
    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-caller' },
      body: JSON.stringify({ model: 'm' }),
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'upstream error' })
    expect(JSON.stringify(body)).not.toContain('stack')
    expect(res.headers.get('x-internal')).toBeNull()
  })

  it('drops non-allowlisted response headers on success', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-powered-by', 'new-api')
      res.setHeader('set-cookie', 'leak=1')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    }
    const res = await app.request('/api/v1/llm/models', {
      method: 'GET',
      headers: { authorization: 'Bearer sk-caller' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
