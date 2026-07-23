import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GET as listFlows } from './route'

/**
 * Integration tests for `GET /api/flows` (P1.10.T5).
 *
 * The route fetches the gateway's read-only Flowise passthrough; these tests
 * stub the gateway on an ephemeral port and assert the console envelope:
 *  - 502 when the gateway is unreachable
 *  - lists flows colored by their latest execution's state
 *  - tolerates Flowise's two list shapes (bare array vs {data,total})
 *  - tolerates a malformed chatflow row (skipped, not fatal)
 */

let stub: Server | null = null
let stubUrl = ''

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

function req(cookie?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  return new NextRequest('http://localhost/api/flows', { method: 'GET', headers })
}

/** The route's GET takes the inbound request (for cookie/run-id threading). */
function callList(cookie?: string): Promise<Response> {
  return listFlows(req(cookie))
}

const chatflowRow = (id: string, name: string, flowData: string) => ({
  id,
  name,
  type: 'AGENTFLOW',
  flowData,
  createdDate: '2026-07-01T00:00:00Z',
  updatedDate: '2026-07-09T00:00:00Z',
})

const sampleFlowData = JSON.stringify({
  nodes: [
    { id: 'n1', type: 'Start', position: { x: 0, y: 0 }, data: { label: '开始' } },
    { id: 'n2', type: 'Agent', position: { x: 200, y: 0 }, data: { label: 'reader' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
})

describe('GET /api/flows', () => {
  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await callList()
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('lists flows colored by their latest execution state', async () => {
    const flows = [
      chatflowRow('f1', '复现流水线', sampleFlowData),
      chatflowRow('f2', '假设生成', '{}'),
    ]
    const execs = [
      {
        id: 'e1',
        agentflowId: 'f1',
        sessionId: 's1',
        state: 'INPROGRESS',
        executionData: [{ nodeId: 'n1', status: 'FINISHED' }, { nodeId: 'n2', status: 'INPROGRESS' }],
        createdDate: '2026-07-09T00:00:00Z',
        updatedDate: '2026-07-09T00:00:00Z',
      },
    ]
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      // Flowise's getAllExecutions always returns the { data, total } envelope —
      // the production shape. A bare array here would hide an envelope-parsing
      // regression (every execution silently dropped → all flows idle).
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: execs, total: execs.length }))
      else res.end(JSON.stringify(flows))
    })

    const res = await callList()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toHaveLength(2)
    expect(json.data[0]).toMatchObject({ id: 'f1', name: '复现流水线', status: 'running', nodeCount: 2 })
    expect(json.data[1]).toMatchObject({ id: 'f2', name: '假设生成', status: 'idle', nodeCount: 0 })
  })

  it('parses executions from the Flowise { data, total } envelope, not a bare array', async () => {
    // Regression guard: the production executions response is the paginated
    // `{ data, total }` envelope. If the route ever reverts to bare-array-only
    // parsing, `Array.isArray({data,total})` is false and every execution is
    // dropped — f1 would silently degrade to `idle` instead of `running`.
    const flows = [chatflowRow('f1', '复现流水线', sampleFlowData)]
    const execs = [
      {
        id: 'e1',
        agentflowId: 'f1',
        sessionId: 's1',
        state: 'INPROGRESS',
        executionData: [{ nodeId: 'n1', status: 'INPROGRESS' }],
        createdDate: '2026-07-09T00:00:00Z',
        updatedDate: '2026-07-09T00:00:00Z',
      },
    ]
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: execs, total: execs.length }))
      else res.end(JSON.stringify(flows))
    })

    const res = await callList()
    expect(res.status).toBe(200)
    const json = await res.json()
    // The execution reached the row → status is `running`, proving the envelope
    // was unwrapped. A regression drops it and this becomes `idle`.
    expect(json.data[0]).toMatchObject({ id: 'f1', status: 'running', nodeCount: 2 })
  })

  it('tolerates Flowise paginated { data, total } list shape', async () => {
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: [], total: 0 }))
      else res.end(JSON.stringify({ data: [chatflowRow('f1', 'A', '{}')], total: 1 }))
    })
    const res = await callList()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].id).toBe('f1')
  })

  it('skips a malformed chatflow row without failing the whole list', async () => {
    const flows = [
      { id: 'f1', name: 'good', type: 'AGENTFLOW', flowData: '{}', createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-09T00:00:00Z' },
      { id: 'f2', /* missing name */ type: 'AGENTFLOW', createdDate: 'x', updatedDate: 'y' },
    ]
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: [], total: 0 }))
      else res.end(JSON.stringify(flows))
    })
    const res = await callList()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].id).toBe('f1')
  })

  it('forwards the SSO session cookie to the gateway (M5b.4 HIGH#1)', async () => {
    // `/api/v1/chatflows` is non-public under REQUIRE_LOGIN=1; the route must
    // thread the caller's session cookie so the gateway's session middleware
    // sees the caller — otherwise the Flows browse page 401s for logged-in users.
    let receivedCookie = ''
    await withStub((req, res) => {
      receivedCookie = req.headers['cookie'] ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: [], total: 0 }))
      else res.end(JSON.stringify([chatflowRow('f1', 'A', '{}')]))
    })
    const res = await callList('mil_session=tok-abc')
    expect(res.status).toBe(200)
    expect(receivedCookie).toContain('mil_session=tok-abc')
  })
})
