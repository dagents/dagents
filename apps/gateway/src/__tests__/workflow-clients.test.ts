import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createLlmClient,
  createBuiltInToolRegistry,
} from '../routes/workflow-clients.js'

const mockRunQuery = vi.fn()

vi.mock('@dagents/db', () => ({
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Default provider row: base64 api key, stub server base URL.
  mockRunQuery.mockResolvedValue({
    records: [
      {
        id: 'p1',
        base_url: stubUrl,
        api_key: Buffer.from('sk-test').toString('base64'),
        default_model: 'test-model',
        provider_type: 'openai',
      },
    ],
    affected: 1,
  })
})

let stubServer: Server
let stubUrl = ''
/** Last request body recorded by the stub (parsed JSON). */
let lastRequestBody: Record<string, unknown> = {}

/** OpenAI-compatible SSE stream: two deltas, usage frame, [DONE]. */
function sseStreamHandler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    lastRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    res.setHeader('content-type', 'text/event-stream')
    res.writeHead(200)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
}

beforeAll(async () => {
  stubServer = createServer((req, res) => sseStreamHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => stubServer.close(() => resolve()))
})

describe('createLlmClient.chatStream', () => {
  it('parses OpenAI-compatible SSE deltas and usage', async () => {
    const client = createLlmClient()
    const chunks: Array<{ delta?: string; usage?: unknown }> = []
    for await (const chunk of client.chatStream!({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk)
    }

    expect(chunks.map((c) => c.delta).filter(Boolean)).toEqual(['Hello', ' world'])
    const usageFrame = chunks.find((c) => c.usage)
    expect(usageFrame?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  })

  it('requests stream:true with stream_options.include_usage', async () => {
    const client = createLlmClient()
    let chunks = 0
    for await (const _chunk of client.chatStream!({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    })) {
      chunks += 1
    }
    expect(chunks).toBeGreaterThanOrEqual(2)
    expect(lastRequestBody.stream).toBe(true)
    expect(lastRequestBody.stream_options).toEqual({ include_usage: true })
    expect(lastRequestBody.model).toBe('test-model')
    expect(lastRequestBody.temperature).toBe(0.2)
  })
})

describe('createBuiltInToolRegistry', () => {
  it('exposes http_request and datetime_now', () => {
    const registry = createBuiltInToolRegistry()
    expect(Object.keys(registry).sort()).toEqual(['datetime_now', 'http_request'])
    expect(registry.http_request.parameters).toMatchObject({ type: 'object' })
  })

  it('http_request performs the request and returns status + body', async () => {
    const registry = createBuiltInToolRegistry()
    // Point at the stub (any path) — it responds with SSE text; the tool just
    // wraps whatever came back.
    const result = await registry.http_request.handler({ url: `${stubUrl}/x` })
    const parsed = JSON.parse(result) as { status: number; body: string }
    expect(parsed.status).toBe(200)
    expect(parsed.body).toContain('Hello')
  })

  it('http_request rejects non-http(s) urls', async () => {
    const registry = createBuiltInToolRegistry()
    const result = await registry.http_request.handler({ url: 'file:///etc/passwd' })
    expect(result).toMatch(/Error: url must be/)
  })

  it('datetime_now returns an ISO timestamp', async () => {
    const registry = createBuiltInToolRegistry()
    const result = await registry.datetime_now.handler({})
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
