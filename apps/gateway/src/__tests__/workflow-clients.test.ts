import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createLlmClient,
  createBuiltInToolRegistry,
  createHistoryRetriever,
  createFlowExecutor,
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

describe('createHistoryRetriever', () => {
  it('builds an ANDed ILIKE query over chat_messages and maps rows', async () => {
    mockRunQuery.mockResolvedValue({
      records: [{ role: 'user', content: 'weather is nice', created_at: new Date('2026-08-15T00:00:00Z') }],
      affected: 1,
    })
    const retriever = createHistoryRetriever('11111111-1111-1111-1111-111111111111')
    const docs = await retriever('weather today', 4)

    expect(docs).toEqual([
      { role: 'user', content: 'weather is nice', createdAt: '2026-08-15T00:00:00.000Z' },
    ])
    const [sql, params] = mockRunQuery.mock.calls[0]
    expect(sql).toContain('chat_messages')
    expect(sql).toContain('ILIKE')
    expect(params[0]).toBe('11111111-1111-1111-1111-111111111111')
    expect(params[1]).toBe('%weather%')
    expect(params[2]).toBe('%today%')
  })

  it('drops short words and returns [] for an empty query', async () => {
    const retriever = createHistoryRetriever('11111111-1111-1111-1111-111111111111')
    expect(await retriever('a b', 4)).toEqual([])
    expect(mockRunQuery).not.toHaveBeenCalled()
  })

  it('returns [] when the query fails', async () => {
    mockRunQuery.mockRejectedValue(new Error('db down'))
    const retriever = createHistoryRetriever('11111111-1111-1111-1111-111111111111')
    expect(await retriever('weather', 4)).toEqual([])
  })
})

describe('createFlowExecutor (subflow execution)', () => {
  const SUBFLOW_ID = '22222222-2222-2222-2222-222222222222'

  function makeSubflowDeps() {
    return {
      chatId: 'c1',
      runId: 'r1',
      llmClient: { chat: vi.fn().mockResolvedValue({ text: 'ok' }) },
      agentFetcher: vi.fn(),
      toolRegistry: {},
      historyRetriever: vi.fn(),
    }
  }

  function stubSubflow(flowData: unknown) {
    mockRunQuery.mockResolvedValue({
      records: [{ name: 'subflow', flow_data: flowData }],
      affected: 1,
    })
  }

  it('executes the referenced flow and returns its final output', async () => {
    stubSubflow({
      nodes: [
        { id: 'cf', data: { name: 'customFunctionAgentflow', functionCode: "return { content: 'sub(' + $input + ')' }" } },
      ],
      edges: [],
    })
    const collected: unknown[] = []
    const executor = createFlowExecutor({ ...makeSubflowDeps(), onExecutedNodes: (ns) => collected.push(...ns) })

    const output = await executor(SUBFLOW_ID, 'hello')
    expect(output.content).toBe('sub(hello)')
    // Subflow executed nodes are surfaced to the parent's span persistence.
    expect(collected).toHaveLength(1)
    expect((collected[0] as { nodeId: string }).nodeId).toBe('cf')
  })

  it('rejects on a non-uuid flow id', async () => {
    const executor = createFlowExecutor(makeSubflowDeps())
    await expect(executor('not-a-uuid', {})).rejects.toThrow(/invalid flow id/)
  })

  it('rejects when the flow does not exist', async () => {
    mockRunQuery.mockResolvedValue({ records: [], affected: 0 })
    const executor = createFlowExecutor(makeSubflowDeps())
    await expect(executor(SUBFLOW_ID, {})).rejects.toThrow(/not found/)
  })

  it('propagates subflow failure as a clear error', async () => {
    stubSubflow({
      nodes: [{ id: 'boom', data: { name: 'customFunctionAgentflow', functionCode: 'throw new Error("炸了")' } }],
      edges: [],
    })
    const executor = createFlowExecutor(makeSubflowDeps())
    await expect(executor(SUBFLOW_ID, {})).rejects.toThrow(/subflow "subflow" failed.*炸了/)
  })

  it('guards against runaway recursion (self-referencing flow)', async () => {
    // The flow executes itself via an ExecuteFlow node — must stop at the
    // depth cap instead of recursing forever.
    stubSubflow({
      nodes: [
        { id: 'ef', data: { name: 'executeFlowAgentflow', flowId: SUBFLOW_ID } },
      ],
      edges: [],
    })
    const executor = createFlowExecutor(makeSubflowDeps())
    await expect(executor(SUBFLOW_ID, {})).rejects.toThrow(/max depth|failed/)
  })
})
