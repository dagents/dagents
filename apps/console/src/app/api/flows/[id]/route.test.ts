import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GET as getFlow } from './route'

/**
 * Integration tests for `GET /api/flows/[id]` (P1.10.T5).
 *
 * Stubs the gateway's read-only Flowise passthrough and asserts the console
 * `FlowDetailView` envelope: nodes painted with status from the latest
 * execution, 502 on gateway failure, 400 on a missing id.
 */

let stub: Server | null = null

async function withStub(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<void> {
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

const sampleFlowData = JSON.stringify({
  nodes: [
    { id: 'n1', type: 'Start', position: { x: 0, y: 0 }, data: { label: '开始' } },
    { id: 'n2', type: 'Agent', position: { x: 200, y: 0 }, data: { label: 'reader' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
})

describe('GET /api/flows/[id]', () => {
  it('returns the flow detail with nodes painted by the latest execution', async () => {
    const flow = {
      id: 'f1',
      name: '复现流水线',
      type: 'AGENTFLOW',
      flowData: sampleFlowData,
      createdDate: '2026-07-01T00:00:00Z',
      updatedDate: '2026-07-09T00:00:00Z',
    }
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
      // regression (every execution silently dropped → all nodes idle).
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: execs, total: execs.length }))
      else res.end(JSON.stringify(flow))
    })

    const res = await getFlow(new NextRequest('http://localhost/api/flows/f1', { method: 'GET' }), { params: Promise.resolve({ id: 'f1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({ id: 'f1', name: '复现流水线', status: 'running' })
    const n1 = json.data.nodes.find((n: { id: string }) => n.id === 'n1')
    const n2 = json.data.nodes.find((n: { id: string }) => n.id === 'n2')
    expect(n1.status).toBe('done')
    expect(n2.status).toBe('running')
  })

  it('paints nodes from the Flowise { data, total } executions envelope, not a bare array', async () => {
    // Regression guard: the production executions response is the paginated
    // `{ data, total }` envelope. If the route ever reverts to bare-array-only
    // parsing, `Array.isArray({data,total})` is false, every execution is
    // dropped, and both nodes silently degrade to `idle` (with no latestExecutionId).
    const flow = {
      id: 'f1',
      name: '复现流水线',
      type: 'AGENTFLOW',
      flowData: sampleFlowData,
      createdDate: '2026-07-01T00:00:00Z',
      updatedDate: '2026-07-09T00:00:00Z',
    }
    const execs = [
      {
        id: 'e1',
        agentflowId: 'f1',
        sessionId: 's1',
        state: 'INPROGRESS',
        executionData: [{ nodeId: 'n1', status: 'INPROGRESS' }, { nodeId: 'n2', status: 'FINISHED' }],
        createdDate: '2026-07-09T00:00:00Z',
        updatedDate: '2026-07-09T00:00:00Z',
      },
    ]
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: execs, total: execs.length }))
      else res.end(JSON.stringify(flow))
    })

    const res = await getFlow(new NextRequest('http://localhost/api/flows/f1', { method: 'GET' }), { params: Promise.resolve({ id: 'f1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    // Envelope was unwrapped → execution reached the mapper, so the flow and
    // its nodes are colored. A regression drops the execution: status → idle,
    // latestExecutionId → undefined, all nodes → idle.
    expect(json.data.status).toBe('running')
    expect(json.data.latestExecutionId).toBe('e1')
    const n1 = json.data.nodes.find((n: { id: string }) => n.id === 'n1')
    expect(n1.status).toBe('running')
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await getFlow(new NextRequest('http://localhost/api/flows/f1', { method: 'GET' }), { params: Promise.resolve({ id: 'f1' }) })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('returns a flow with all-idle nodes when there are no executions', async () => {
    const flow = {
      id: 'f1',
      name: 'A',
      type: 'AGENTFLOW',
      flowData: sampleFlowData,
      createdDate: '2026-07-01T00:00:00Z',
      updatedDate: '2026-07-09T00:00:00Z',
    }
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      if (req.url?.includes('/api/v1/executions')) res.end(JSON.stringify({ data: [], total: 0 }))
      else res.end(JSON.stringify(flow))
    })
    const res = await getFlow(new NextRequest('http://localhost/api/flows/f1', { method: 'GET' }), { params: Promise.resolve({ id: 'f1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.status).toBe('idle')
    expect(json.data.nodes.every((n: { status: string }) => n.status === 'idle')).toBe(true)
  })
})
