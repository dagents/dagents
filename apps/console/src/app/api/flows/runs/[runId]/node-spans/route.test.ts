import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GET as getNodeSpans } from './route'

/**
 * Integration tests for `GET /api/flows/runs/:runId/node-spans` (M6.4).
 *
 * Stubs the gateway's scheduler passthrough and asserts the console route's
 * fetch / status-mapping behavior: 200 envelope passthrough, 404 forwarded
 * verbatim, 5xx → 502, gateway-unreachable → 502. Mirrors the
 * `flows/[id]/route.test.ts` stub-gateway pattern.
 */

let stub: Server | null = null

async function withStub(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<void> {
  stub = createServer(handler)
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve))
  const addr = stub.address() as AddressInfo
  process.env.GATEWAY_URL = `http://127.0.0.1:${addr.port}`
}

afterEach(async () => {
  if (stub) {
    await new Promise<void>((r) => stub!.close(() => r()))
    stub = null
  }
  delete process.env.GATEWAY_URL
})

describe('GET /api/flows/runs/:runId/node-spans', () => {
  it('passes the scheduler envelope through verbatim on 200', async () => {
    const envelope = {
      success: true,
      data: {
        runId: 'r1',
        spans: [
          { nodeId: 'n1', status: 'done', cost: '0.420000', tokens: { input_tokens: 10 } },
        ],
      },
    }
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify(envelope))
    })

    const res = await getNodeSpans(new Request('http://localhost/api/flows/runs/r1/node-spans'), {
      params: Promise.resolve({ runId: 'r1' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual(envelope)
  })

  it('forwards a 404 verbatim (run not found, distinct from empty spans)', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: 'run not found' }))
    })

    const res = await getNodeSpans(new Request('http://localhost/api/flows/runs/missing/node-spans'), {
      params: Promise.resolve({ runId: 'missing' }),
    })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('collapses a scheduler 5xx to 502 (sanitized, no body leak)', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /src/scheduler/…' }))
    })

    const res = await getNodeSpans(new Request('http://localhost/api/flows/runs/r1/node-spans'), {
      params: Promise.resolve({ runId: 'r1' }),
    })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    // the leaky upstream body must NOT reach the client — on 5xx the console
    // route sends only the status, never the upstream detail
    expect(JSON.stringify(json)).not.toContain('stack')
    expect(JSON.stringify(json)).not.toContain('boom')
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await getNodeSpans(new Request('http://localhost/api/flows/runs/r1/node-spans'), {
      params: Promise.resolve({ runId: 'r1' }),
    })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('forwards a caller x-run-id to the gateway (M6.1 trace correlation)', async () => {
    let receivedRunId: string | null = null
    await withStub((req, res) => {
      receivedRunId = (req.headers['x-run-id'] as string | undefined) ?? null
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { runId: 'r1', spans: [] } }))
    })

    await getNodeSpans(
      new Request('http://localhost/api/flows/runs/r1/node-spans', { headers: { 'x-run-id': 'caller-run-9' } }),
      { params: Promise.resolve({ runId: 'r1' }) },
    )
    expect(receivedRunId).toBe('caller-run-9')
  })
})
