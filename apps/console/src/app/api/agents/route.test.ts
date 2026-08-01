import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

/**
 * Integration tests for the `/api/agents` list proxy (M5a.2 / P1.10.T4).
 *
 * Mirrors api/chat/route.test.ts: the route is a security boundary that keeps
 * the gateway URL server-side and collapses upstream failures to a 502 the view
 * surfaces. `GATEWAY_URL` is repointed at a stub HTTP server (or a dead port)
 * per test. Coverage:
 *  - gateway unreachable → 502 (fetch throws → sanitized envelope)
 *  - gateway 200 + JSON envelope → forwarded verbatim with content-type
 *  - gateway non-2xx → forwarded as-is (status + truncated detail)
 *  - x-run-id forwarded when well-formed
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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

function agentsReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/agents', { method: 'GET', headers })
}

describe('GET /api/agents', () => {
  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await GET(agentsReq())
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })

  it('forwards a 200 dispatch envelope verbatim with content-type', async () => {
    const body = JSON.stringify({
      success: true,
      data: { agents: [{ id: 'a1', name: 'reader', kind: 'claude' }], truncated: false },
    })
    let receivedPath = ''
    let receivedRunId = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      const rid = req.headers['x-run-id']
      receivedRunId = Array.isArray(rid) ? (rid[0] ?? '') : (rid ?? '')
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(body)
    })

    const res = await GET(agentsReq({ 'x-run-id': 'run-agents-1' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.agents).toHaveLength(1)
    expect(json.data.agents[0].id).toBe('a1')

    // The route forwards to the gateway's unified agents path.
    expect(receivedPath).toBe('/api/v1/agents')
    expect(receivedRunId).toBe('run-agents-1')
  })

  it('forwards an upstream non-2xx as-is with truncated detail', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: 'agent not found' }))
    })

    const res = await GET(agentsReq())
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('agents list failed')
    expect(json.status).toBe(404)
  })

  it('forwards query params through to the gateway', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { agents: [], truncated: false } }))
    })

    const res = await GET(agentsReq())
    await res.json()
    expect(receivedSearch).toBe('/api/v1/agents')

    // With a query string, it should be forwarded.
    const reqWithQuery = new NextRequest('http://localhost/api/agents?kind=claude&status=running', {
      method: 'GET',
    })
    await GET(reqWithQuery)
    expect(receivedSearch).toBe('/api/v1/agents?kind=claude&status=running')
  })

  // M5b.4: an absent caller id is replaced with a generated UUID so the
  // gateway hop is always traceable (the "所有请求带 run_id" bar).
  it('generates an x-run-id when the caller omits one', async () => {
    let receivedRunId: string | undefined
    await withStub((req, res) => {
      const rid = req.headers['x-run-id']
      receivedRunId = Array.isArray(rid) ? (rid[0] ?? '') : (rid ?? '')
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { agents: [], truncated: false } }))
    })

    await GET(agentsReq())
    expect(receivedRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
