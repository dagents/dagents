import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'
import { randomUUID } from 'node:crypto'

const mockRunQuery = vi.fn()

vi.mock('@dagents/db', () => ({
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64')
}

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
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
})

afterEach(() => {
  recorded = { lastReq: null }
  stubHandler = defaultHandler
})

const recordedReq = (): Request | null => recorded.lastReq

function mockActiveProvider(overrides: Record<string, unknown> = {}) {
  const id = randomUUID()
  return {
    id,
    base_url: stubUrl,
    api_key: base64Encode('sk-provider-key-123'),
    status: 'active',
    ...overrides,
  }
}

describe('gateway llm provider proxy', () => {
  it('uses provider specified by X-LLM-Provider-Id header', async () => {
    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toBe('hi back')

    const upstream = recordedReq()!
    expect(upstream.method).toBe('POST')
    expect(upstream.url).toContain('/chat/completions')
    expect(upstream.headers.get('authorization')).toBe('Bearer sk-provider-key-123')
  })

  it('uses first active provider when X-LLM-Provider-Id header is missing', async () => {
    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)

    const upstream = recordedReq()!
    expect(upstream.headers.get('authorization')).toBe('Bearer sk-provider-key-123')

    const callArgs = mockRunQuery.mock.calls[0]
    const sql = callArgs[0] as string
    expect(sql).toContain("status = 'active'")
    expect(sql).toContain('ORDER BY updated_at DESC')
    expect(sql).toContain('LIMIT 1')
  })

  it('returns 400 when no provider is available', async () => {
    mockRunQuery.mockResolvedValueOnce({ records: [] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('no llm provider available')
    expect(recordedReq()).toBeNull()
  })

  it('returns 400 when specified provider does not exist', async () => {
    const fakeId = randomUUID()
    mockRunQuery.mockResolvedValueOnce({ records: [] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': fakeId,
      },
      body: JSON.stringify({ model: 'gpt-4' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('no llm provider available')
    expect(recordedReq()).toBeNull()
  })

  it('replaces Authorization header with provider apiKey', async () => {
    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
        'authorization': 'Bearer sk-caller-should-be-replaced',
      },
      body: JSON.stringify({ model: 'gpt-4' }),
    })

    const upstream = recordedReq()!
    expect(upstream.headers.get('authorization')).toBe('Bearer sk-provider-key-123')
    expect(upstream.headers.get('authorization')).not.toContain('sk-caller')
  })

  it('rewrites path correctly: /api/v1/llm/chat/completions → {baseUrl}/chat/completions', async () => {
    const provider = mockActiveProvider({ base_url: stubUrl + '/v1' })
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
      },
      body: JSON.stringify({ model: 'gpt-4' }),
    })

    const upstream = recordedReq()!
    expect(upstream.url).toContain('/v1/chat/completions')
  })

  it('forwards query string', async () => {
    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    await app.request('/api/v1/llm/models?limit=5', {
      method: 'GET',
      headers: { 'x-llm-provider-id': provider.id },
    })

    const upstream = recordedReq()!
    expect(upstream.url).toContain('/models?limit=5')
  })

  it('streams SSE response body', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      res.setHeader('connection', 'keep-alive')
      res.writeHead(200)
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    }

    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
      },
      body: JSON.stringify({ model: 'gpt-4', stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const body = await res.text()
    expect(body).toContain('Hello')
    expect(body).toContain('world')
    expect(body).toContain('[DONE]')
  })

  it('passes through 401 from upstream', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(401)
      res.end(JSON.stringify({ error: { message: 'Invalid token' } }))
    }

    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
      },
      body: JSON.stringify({ model: 'gpt-4' }),
    })
    expect(res.status).toBe(401)
  })

  it('passes through 429 from upstream', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(429)
      res.end(JSON.stringify({ error: { message: 'rate limited' } }))
    }

    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
      },
      body: JSON.stringify({ model: 'gpt-4' }),
    })
    expect(res.status).toBe(429)
  })

  it('collapses upstream 5xx to sanitized 502', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'secret-host')
      res.writeHead(502)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /internal/…' }))
    }

    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider-id': provider.id,
      },
      body: JSON.stringify({ model: 'gpt-4' }),
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body).toMatchObject({ success: false, error: 'upstream error' })
    expect(JSON.stringify(body)).not.toContain('stack')
    expect(res.headers.get('x-internal')).toBeNull()
  })

  it('drops non-allowlisted response headers on success', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-powered-by', 'some-llm')
      res.setHeader('set-cookie', 'leak=1')
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    }

    const provider = mockActiveProvider()
    mockRunQuery.mockResolvedValueOnce({ records: [provider] })

    const res = await app.request('/api/v1/llm/models', {
      method: 'GET',
      headers: { 'x-llm-provider-id': provider.id },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })


})
