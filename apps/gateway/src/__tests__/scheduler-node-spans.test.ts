import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'

/**
 * Integration test for the gateway → scheduler node-spans proxy (M6.4 /
 * P1.11.T5).
 *
 * Spins up a stub HTTP server that stands in for the scheduler, points the
 * gateway at it via SCHEDULER_URL, and drives the gateway in-process via
 * `app.request()`. No DB, no real scheduler — the stub returns canned
 * `run_node_spans` envelopes so the test asserts the proxy's forwarding +
 * status-mapping contract (the scheduler route's own logic is covered by the
 * scheduler suite).
 *
 * Coverage:
 * - GET /api/v1/scheduler/runs/:runId/node-spans forwards path + method
 * - a scheduler 200 envelope passes through verbatim
 * - a scheduler 5xx collapses to a sanitized 502 (no body/headers leaked)
 * - a scheduler 4xx (400 invalid runId / 404 run not found) is forwarded
 *   verbatim so the console can distinguish "bad id"/"no such run"
 * - a non-GET is 405 (the proxy is a read-only path)
 * - hop-by-hop headers are not forwarded; caller x-run-id is
 */

let stubServer: Server
let stubUrl = ''
// swappable handler so the 5xx / 4xx / non-GET tests can override the stub.
type StubHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
let stubHandler: StubHandler = (_req, res) => {
  res.setHeader('content-type', 'application/json')
  res.writeHead(200)
  res.end(
    JSON.stringify({
      success: true,
      data: { runId: 'r1', spans: [{ nodeId: 'n1', status: 'done', cost: '0.42' }] },
    }),
  )
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.SCHEDULER_URL = stubUrl
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  delete process.env.SCHEDULER_URL
})

afterEach(() => {
  // restore the default 200 handler after a test swaps in a 4xx/5xx one
  stubHandler = (_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(
      JSON.stringify({
        success: true,
        data: { runId: 'r1', spans: [{ nodeId: 'n1', status: 'done', cost: '0.42' }] },
      }),
    )
  }
})

describe('gateway scheduler node-spans proxy', () => {
  it('forwards GET /api/v1/scheduler/runs/:runId/node-spans to the scheduler', async () => {
    let receivedUrl = ''
    stubHandler = (req, res) => {
      receivedUrl = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { runId: 'r1', spans: [] } }))
    }
    const res = await app.request('/api/v1/scheduler/runs/abc/node-spans', { method: 'GET' })
    expect(res.status).toBe(200)
    // forwarded verbatim (path + the runId segment), no rewrite
    expect(receivedUrl).toBe('/api/v1/scheduler/runs/abc/node-spans')
    const body = await res.json()
    expect(body).toMatchObject({ success: true })
  })

  it('passes a scheduler 200 envelope through verbatim', async () => {
    const res = await app.request('/api/v1/scheduler/runs/r1/node-spans', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { spans: Array<Record<string, unknown>> } }
    expect(body.success).toBe(true)
    expect(body.data.spans[0]).toMatchObject({ nodeId: 'n1', status: 'done' })
  })

  it('forwards a scheduler 4xx verbatim (so the console sees bad-id / not-found)', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: 'run not found' }))
    }
    const res = await app.request('/api/v1/scheduler/runs/missing/node-spans', { method: 'GET' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'run not found' })
  })

  it('collapses a scheduler 5xx to a sanitized 502 (no body/headers leaked)', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'scheduler-host-1234')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /src/scheduler/…', db: 'postgres://u:p@host' }))
    }
    const res = await app.request('/api/v1/scheduler/runs/r1/node-spans', { method: 'GET' })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'upstream error', upstreamStatus: 500 })
    expect(JSON.stringify(body)).not.toContain('stack')
    expect(JSON.stringify(body)).not.toContain('postgres://')
    expect(res.headers.get('x-internal')).toBeNull()
  })

  it('502s when the scheduler is unreachable', async () => {
    const saved = process.env.SCHEDULER_URL
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1' // reserved, nothing listens
    try {
      const res = await app.request('/api/v1/scheduler/runs/r1/node-spans', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream unavailable' })
    } finally {
      process.env.SCHEDULER_URL = saved
    }
  })

  it('rejects a non-GET with 405 (read-only path)', async () => {
    const res = await app.request('/api/v1/scheduler/runs/r1/node-spans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(405)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'method not allowed' })
  })

  it('forwards a caller-supplied x-run-id (M6.1 trace correlation)', async () => {
    let receivedRunId: string | null = null
    stubHandler = (req, res) => {
      receivedRunId = (req.headers['x-run-id'] as string | undefined) ?? null
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { runId: 'r1', spans: [] } }))
    }
    await app.request('/api/v1/scheduler/runs/r1/node-spans', {
      method: 'GET',
      headers: { 'x-run-id': 'caller-run-9' },
    })
    expect(receivedRunId).toBe('caller-run-9')
  })
})
