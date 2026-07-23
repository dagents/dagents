import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

/**
 * Integration tests for the `/api/chat` route handler (P1.10.T2, review #3).
 *
 * The route is a security boundary: zod validates the body, the gateway URL
 * stays server-side, and upstream failures collapse to a 502 the chat view
 * surfaces inline. These tests pin that contract without a real gateway —
 * `GATEWAY_URL` is repointed at a stub HTTP server (or a dead port) per test.
 *
 * Coverage (review asked for 2–3):
 *  - empty/invalid body → 400 (zod rejection, no upstream call)
 *  - gateway unreachable → 502 (fetch throws → sanitized envelope)
 *  - gateway 200 + SSE body → streamed through verbatim with content-type
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let stub: Server | null = null
let stubUrl = ''

/** Spin up a stub gateway on an ephemeral port and point the route at it. */
async function withStub(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<void> {
  stub = createServer(handler)
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
})

function chatReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/chat', () => {
  it('rejects an empty body with 400 and never dials the gateway', async () => {
    // Point GATEWAY_URL at a dead port; if the route dialed it, the test would
    // either hang or 502 instead of 400. A 400 proves zod short-circuited.
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await POST(chatReq({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('invalid chat body')
  })

  it('rejects a non-string flowId with 400', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await POST(chatReq({ flowId: 123, question: 'hi' }))
    expect(res.status).toBe(400)
  })

  it('returns 502 when the gateway is unreachable', async () => {
    // Port 1 is reserved and never listens → fetch throws ECONNREFUSED.
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await POST(
      chatReq(
        { flowId: 'd87207fd-7a11-4d42-8580-2f03ca58e79d', question: 'hi', streaming: true },
        { 'x-run-id': 'run-test-1' },
      ),
    )
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })

  it('streams a 200 SSE body through verbatim with content-type + x-run-id', async () => {
    const sseBody = 'message:\ndata:{"event":"token","data":"hi"}\n\nmessage:\ndata:{"event":"end","data":"[DONE]"}\n\n'
    let receivedPath = ''
    let receivedRunId = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      const rid = req.headers['x-run-id']
      receivedRunId = Array.isArray(rid) ? (rid[0] ?? '') : (rid ?? '')
      res.setHeader('content-type', 'text/event-stream')
      res.writeHead(200)
      res.end(sseBody)
    })

    const res = await POST(
      chatReq(
        { flowId: 'd87207fd-7a11-4d42-8580-2f03ca58e79d', question: 'hi', streaming: true },
        { 'x-run-id': 'run-test-2' },
      ),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-run-id')).toBe('run-test-2')

    // The route must pipe the upstream body straight through (not buffer it).
    const text = await res.text()
    expect(text).toBe(sseBody)

    // The route rewrites to the gateway's prediction path and forwards run id.
    expect(receivedPath).toBe('/api/v1/flows/d87207fd-7a11-4d42-8580-2f03ca58e79d/prediction')
    expect(receivedRunId).toBe('run-test-2')
  })

  it('forwards an upstream non-2xx as-is (gateway collapses to 502)', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(502)
      res.end(JSON.stringify({ success: false, error: 'upstream error', upstreamStatus: 500 }))
    })

    const res = await POST(
      chatReq(
        { flowId: 'd87207fd-7a11-4d42-8580-2f03ca58e79d', question: 'hi', streaming: true },
        { 'x-run-id': 'run-test-3' },
      ),
    )
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('prediction failed')
    expect(json.status).toBe(502)
  })

  // M5b.4: an absent caller id is replaced with a generated UUID so the chat
  // hop is always traceable (the "所有请求带 run_id" bar). The generated id is
  // echoed on the response so the chat inspector can show it.
  it('generates an x-run-id when the caller omits one and echoes it back', async () => {
    const sseBody = 'message:\ndata:{"event":"end","data":"[DONE]"}\n\n'
    let receivedRunId = ''
    await withStub((req, res) => {
      const rid = req.headers['x-run-id']
      receivedRunId = Array.isArray(rid) ? (rid[0] ?? '') : (rid ?? '')
      res.setHeader('content-type', 'text/event-stream')
      res.writeHead(200)
      res.end(sseBody)
    })

    const res = await POST(
      chatReq({ flowId: 'd87207fd-7a11-4d42-8580-2f03ca58e79d', question: 'hi', streaming: true }),
    )

    expect(res.status).toBe(200)
    expect(receivedRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // The generated id is echoed on the response so the client can adopt it.
    expect(res.headers.get('x-run-id')).toBe(receivedRunId)
  })
})
