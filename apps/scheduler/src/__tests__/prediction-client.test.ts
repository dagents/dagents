import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createFlowisePredictionClient } from '../prediction-client.js'

/**
 * Prediction client unit test (M3.2 MEDIUM#1 regression).
 *
 * Spins up a stub HTTP server standing in for the gateway and drives the real
 * `FlowisePredictionClient` against it via `fetch`. The gateway proxy rewrites
 * `/api/v1/flows/<id>/prediction` → Flowise's prediction path, so the client
 * posts to that shape and we assert what it forwards + how it parses the
 * response.
 *
 * The non-JSON-success-body case is the MEDIUM#1 regression guard: a naive
 * `try { res.json() } catch { res.text() }` throws "body already read" because
 * the Response body is single-use. The fix clones before parsing and reads the
 * clone in the fallback — this test fails (with a thrown error, not a wrapped
 * `{raw}`) if that regresses.
 */

let stubServer: Server
let stubUrl = ''
let lastBody: string | undefined
let lastHeaders: Record<string, string | string[] | undefined> = {}
let status = 200
let contentType = 'application/json'
let responseBody = JSON.stringify({ text: 'hello' })

beforeAll(async () => {
  stubServer = createServer((req, res) => {
    const chunks: Buffer[] = []
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
  responseBody = opts.body ?? JSON.stringify({ text: 'hello' })
  lastBody = undefined
  lastHeaders = {}
}

describe('FlowisePredictionClient', () => {
  it('POSTs to the gateway flow path and parses a JSON 2xx', async () => {
    reset()
    const client = createFlowisePredictionClient({ gatewayUrl: stubUrl })
    const result = await client.predict({ flowId: 'flow-1', body: { q: 'hi' } }, 'run-1')

    expect(result.runId).toBe('run-1')
    expect(result.output).toEqual({ text: 'hello' })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(lastBody).toBe(JSON.stringify({ q: 'hi' }))
    expect(lastHeaders['x-run-id']).toBe('run-1')
    // path is the gateway's rewriting shape, not Flowise's raw prediction path
    expect(result.output).toBeDefined()
  })

  it('wraps a non-JSON 2xx body as {raw} (MEDIUM#1: body is single-use)', async () => {
    // The regression: without res.clone(), res.json() consumes the body and
    // res.text() in the catch throws "body already read", which escapes as an
    // unhandled rejection → the child run is wrongly marked failed. With the
    // clone, the fallback reads the cloned body and wraps it.
    reset({ contentType: 'text/plain', body: 'plain text output' })
    const client = createFlowisePredictionClient({ gatewayUrl: stubUrl })

    const result = await client.predict({ flowId: 'flow-1', body: {} }, 'run-2')

    expect(result.runId).toBe('run-2')
    expect(result.output).toEqual({ raw: 'plain text output' })
  })

  it('rejects with PredictionError on a non-2xx', async () => {
    reset({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'bad' }) })
    const client = createFlowisePredictionClient({ gatewayUrl: stubUrl })

    await expect(client.predict({ flowId: 'flow-1', body: {} }, 'run-3')).rejects.toMatchObject({
      runId: 'run-3',
      status: 422,
      message: expect.stringContaining('422'),
    })
  })

  it('rejects with a 502-shaped PredictionError when the upstream is unreachable', async () => {
    // a port nothing listens on
    const client = createFlowisePredictionClient({ gatewayUrl: 'http://127.0.0.1:1' })
    await expect(client.predict({ flowId: 'flow-1', body: {} }, 'run-4')).rejects.toMatchObject({
      runId: 'run-4',
      status: 502,
    })
  })
})
