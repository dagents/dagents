import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWorkflowPredictionClient } from '../workflow-prediction-client.js'

/**
 * Workflow prediction client unit test.
 *
 * Spins up a stub HTTP server standing in for the gateway and drives the real
 * `WorkflowPredictionClient` against it via `fetch`. The gateway proxy
 * delegates to the workflow engine, so the client posts to the workflow path
 * and we assert what it forwards + how it parses the response.
 *
 * The non-JSON-success-body case is a regression guard: a naive
 * `try { res.json() } catch { res.text() }` throws "body already read" because
 * the Response body is single-use. The fix clones before parsing and reads the
 * clone in the fallback — this test fails (with a thrown error, not a wrapped
 * `{raw}`) if that regresses.
 */

let stubServer: Server
let stubUrl = ''
let lastBody: string | undefined
let lastHeaders: Record<string, string | string[] | undefined> = {}
let lastUrl: string | undefined
let status = 200
let contentType = 'application/json'
let responseBody = JSON.stringify({ data: { output: { text: 'hello' } } })

beforeAll(async () => {
  stubServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    lastUrl = req.url
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8') || undefined
      lastHeaders = req.headers as Record<string, string | string[] | undefined>
      res.setHeader('content-type', contentType)
      res.writeHead(status)
      res.end(responseBody)
    })
  })
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => stubServer.close(() => resolve()))
})

function reset(opts: { status?: number; contentType?: string; body?: string } = {}): void {
  status = opts.status ?? 200
  contentType = opts.contentType ?? 'application/json'
  responseBody = opts.body ?? JSON.stringify({ data: { output: { text: 'hello' } } })
  lastBody = undefined
  lastHeaders = {}
  lastUrl = undefined
}

describe('WorkflowPredictionClient', () => {
  it('POSTs to the gateway workflow path and parses a JSON 2xx', async () => {
    reset()
    const client = createWorkflowPredictionClient({ gatewayUrl: stubUrl })
    const result = await client.predict({ flowId: 'flow-1', body: { input: { q: 'hi' } } }, 'run-1')

    expect(result.runId).toBe('run-1')
    expect(result.output).toEqual({ text: 'hello' })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(lastHeaders['x-run-id']).toBe('run-1')
    expect(lastUrl).toContain('/api/v1/workflows/flow-1/run')

    const body = JSON.parse(lastBody!)
    expect(body.input).toEqual({ q: 'hi' })
    expect(body.chatId).toBe('run-1')
    expect(body.state).toEqual({})
  })

  it('adapts a raw body input into the workflow payload shape', async () => {
    reset()
    const client = createWorkflowPredictionClient({ gatewayUrl: stubUrl })
    await client.predict({ flowId: 'flow-2', body: 'raw-input' }, 'run-2')

    const body = JSON.parse(lastBody!)
    expect(body.input).toBe('raw-input')
    expect(body.chatId).toBe('run-2')
    expect(body.state).toEqual({})
  })

  it('wraps a non-JSON 2xx body as {raw} (body is single-use)', async () => {
    reset({ contentType: 'text/plain', body: 'plain text output' })
    const client = createWorkflowPredictionClient({ gatewayUrl: stubUrl })

    const result = await client.predict({ flowId: 'flow-1', body: {} }, 'run-3')

    expect(result.runId).toBe('run-3')
    expect(result.output).toEqual({ raw: 'plain text output' })
  })

  it('rejects with PredictionError on a non-2xx', async () => {
    reset({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'bad' }) })
    const client = createWorkflowPredictionClient({ gatewayUrl: stubUrl })

    await expect(client.predict({ flowId: 'flow-1', body: {} }, 'run-4')).rejects.toMatchObject({
      runId: 'run-4',
      status: 422,
      message: expect.stringContaining('422'),
    })
  })

  it('rejects with a 502-shaped PredictionError when the upstream is unreachable', async () => {
    const client = createWorkflowPredictionClient({ gatewayUrl: 'http://127.0.0.1:1' })
    await expect(client.predict({ flowId: 'flow-1', body: {} }, 'run-5')).rejects.toMatchObject({
      runId: 'run-5',
      status: 502,
    })
  })

  it('passes authorization header when provided', async () => {
    reset()
    const client = createWorkflowPredictionClient({
      gatewayUrl: stubUrl,
      authorization: 'Bearer test-token',
    })
    await client.predict({ flowId: 'flow-1', body: {} }, 'run-6')

    expect(lastHeaders['authorization']).toBe('Bearer test-token')
  })
})
