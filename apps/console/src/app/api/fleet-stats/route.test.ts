import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

/**
 * Integration tests for the `/api/fleet-stats` proxy (M6.3 / P1.11.T4).
 *
 * Mirrors `api/agents/route.test.ts`: the route is a security boundary that
 * keeps the gateway URL server-side and collapses upstream failures to a 502
 * the view surfaces. `GATEWAY_URL` is repointed at a stub HTTP server (or a
 * dead port) per test. Coverage:
 *  - gateway unreachable → 502 (fetch throws → sanitized envelope)
 *  - gateway 200 + JSON envelope → forwarded verbatim with content-type
 *  - gateway non-2xx → forwarded as-is (status + truncated detail)
 *  - windowHours query forwarded through to the gateway
 *  - design preset ?window=1h|24h|7d resolved to windowHours upstream (M8.1)
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

function fleetReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/fleet-stats', { method: 'GET', headers })
}

describe('GET /api/fleet-stats', () => {
  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await GET(fleetReq())
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })

  it('forwards a 200 dispatch envelope verbatim with content-type', async () => {
    // This payload mirrors the dispatch server's real `fleet-stats` shape
    // (apps/dispatch/src/routes/fleet-stats.ts: fleet.daemons.{byStatus,total}).
    // Keeping the proxy test on the backend contract — not a frontend-invented
    // shape — guards against the schema drift that bit this view once before.
    const body = JSON.stringify({
      success: true,
      data: {
        windowHours: 24,
        windowSince: '2026-07-08T12:57:00.000Z',
        generatedAt: '2026-07-09T12:57:00.000Z',
        fleet: {
          daemons: { byStatus: { online: 1 }, total: 1 },
          agents: { total: 1, byKind: {} },
          tasks: { byStatus: {}, total: 0 },
        },
        throughput: { since: '', tasks: { completed: 0, failed: 0, total: 0 }, runs: { completed: 0, failed: 0, total: 0 } },
        regions: [],
        cost: { totalCost: '0', last24hCost: '0', runsCounted: 0 },
        usage: { byModel: {}, totalCalls: 0, truncated: false },
        sources: { runs: true, langfuse: false, newApi: false },
      },
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

    const res = await GET(fleetReq({ 'x-run-id': 'run-dash-1' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.fleet.daemons.total).toBe(1)

    // The route forwards to the gateway's dispatch passthrough path.
    expect(receivedPath).toBe('/api/v1/dispatch/fleet-stats')
    expect(receivedRunId).toBe('run-dash-1')
  })

  it('forwards an upstream non-2xx as-is with truncated detail', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(500)
      res.end(JSON.stringify({ success: false, error: 'db unavailable' }))
    })

    const res = await GET(fleetReq())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('fleet stats failed')
    expect(json.status).toBe(500)
  })

  it('forwards windowHours through to the gateway', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { windowHours: 168 } }))
    })

    const reqWithQuery = new NextRequest('http://localhost/api/fleet-stats?windowHours=168', {
      method: 'GET',
    })
    await GET(reqWithQuery)
    expect(receivedSearch).toBe('/api/v1/dispatch/fleet-stats?windowHours=168')
  })

  // M8.1: the redesign's time-range segmented toggle sends the design's preset
  // token as `?window=7d`; the proxy resolves it to the dispatch `windowHours`
  // upstream (7d = 168h). A bare `?windowHours=N` (above) stays honored too.
  it('resolves the design preset ?window=7d to windowHours=168 upstream', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { windowHours: 168 } }))
    })

    const reqWithPreset = new NextRequest('http://localhost/api/fleet-stats?window=7d', {
      method: 'GET',
    })
    await GET(reqWithPreset)
    expect(receivedSearch).toBe('/api/v1/dispatch/fleet-stats?windowHours=168')
  })

  it('resolves ?window=1h to windowHours=1 upstream', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { windowHours: 1 } }))
    })

    const reqWithPreset = new NextRequest('http://localhost/api/fleet-stats?window=1h', {
      method: 'GET',
    })
    await GET(reqWithPreset)
    expect(receivedSearch).toBe('/api/v1/dispatch/fleet-stats?windowHours=1')
  })

  it('omits the upstream window when neither window nor windowHours is present', async () => {
    // No query → dispatch uses its 24h default (no upstream windowHours).
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { windowHours: 24 } }))
    })

    await GET(fleetReq())
    expect(receivedSearch).toBe('/api/v1/dispatch/fleet-stats')
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
      res.end(JSON.stringify({ success: true, data: { windowHours: 24 } }))
    })

    await GET(fleetReq())
    expect(receivedRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
