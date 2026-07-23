import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as listWorkspaces } from './route'
import { GET as getWorkspace } from './[id]/route'
import { GET as getThreads } from './[id]/threads/route'

/**
 * Integration tests for the `/api/workspaces/*` proxies (M5b.1 / P1.10.T6).
 *
 * Mirrors `api/fleet-stats/route.test.ts`: each route is a security boundary
 * that keeps the gateway URL server-side and collapses a dial failure to a
 * 502 the view surfaces. `GATEWAY_URL` is repointed at a stub HTTP server (or
 * a dead port) per test. Coverage:
 *  - gateway unreachable → 502 (fetch throws → sanitized envelope)
 *  - gateway 200 + JSON envelope → forwarded verbatim with content-type
 *  - gateway non-2xx → forwarded as-is (status + truncated detail)
 *  - path / query forwarded through to the gateway
 *  - x-run-id forwarded when well-formed
 *  - the :id segment is encoded into the upstream path
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

function wsReq(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET', headers })
}

describe('GET /api/workspaces', () => {
  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await listWorkspaces(wsReq('/api/workspaces'))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })

  it('forwards a 200 workspace list verbatim with content-type', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        items: [
          {
            id: 'ws-1',
            name: '论文复现 · RL',
            glyph: 'R',
            description: 'RL 论文批量复现项目',
            status: 'active',
            memberCount: 3,
            flowCount: 1,
            createdAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
    })
    let receivedPath = ''
    let receivedRunId = ''
    let receivedCookie = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      const rid = req.headers['x-run-id']
      receivedRunId = Array.isArray(rid) ? (rid[0] ?? '') : (rid ?? '')
      receivedCookie = req.headers['cookie'] ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(body)
    })

    const res = await listWorkspaces(
      wsReq('/api/workspaces', { 'x-run-id': 'run-ws-1', cookie: 'mil_session=tok-abc' }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.items).toHaveLength(1)
    expect(json.data.items[0].name).toBe('论文复现 · RL')

    // Forwards to the gateway's workspace list path.
    expect(receivedPath).toBe('/api/v1/workspaces')
    expect(receivedRunId).toBe('run-ws-1')
    // M5b.4: the SSO session cookie is forwarded so the gateway's session
    // middleware sees the caller under REQUIRE_LOGIN=1 (HIGH#1 regression guard).
    expect(receivedCookie).toContain('mil_session=tok-abc')
  })

  it('forwards an upstream non-2xx as-is with truncated detail', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(500)
      res.end(JSON.stringify({ success: false, error: 'db unavailable' }))
    })
    const res = await listWorkspaces(wsReq('/api/workspaces'))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('db unavailable')
  })

  it('forwards includeArchived through to the gateway', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { items: [] } }))
    })
    await listWorkspaces(wsReq('/api/workspaces?includeArchived=true&limit=10'))
    expect(receivedSearch).toBe('/api/v1/workspaces?includeArchived=true&limit=10')
  })
})

describe('GET /api/workspaces/[id]', () => {
  it('encodes the :id into the gateway path and forwards a 200 detail', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        workspace: { id: 'ws-1', name: '论文复现 · RL', glyph: 'R' },
        members: [],
        flows: [],
        artifacts: { reports: 0, datasets: 0, patches: 0 },
      },
    })
    let receivedPath = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(body)
    })

    const res = await getWorkspace(wsReq('/api/workspaces/ws-1'), { params: Promise.resolve({ id: 'ws-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.workspace.name).toBe('论文复现 · RL')
    expect(receivedPath).toBe('/api/v1/workspaces/ws-1')
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await getWorkspace(wsReq('/api/workspaces/ws-1'), { params: Promise.resolve({ id: 'ws-1' }) })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })
})

describe('GET /api/workspaces/[id]/threads', () => {
  it('forwards the threads path and returns a 200 thread', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        items: [
          {
            id: 'run-1',
            identifier: 'R-8821',
            pipelineId: 'flow_repro_01',
            status: 'completed',
            input: { question: '复现这批论文' },
            output: { text: '已派发' },
            artifactUri: null,
            createdByUserId: null,
            traceId: 'trace-1',
            createdAt: '2026-07-09T14:20:00.000Z',
            startedAt: '2026-07-09T14:20:00.000Z',
            finishedAt: '2026-07-09T14:21:00.000Z',
          },
        ],
        nextBefore: null,
      },
    })
    let receivedPath = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(body)
    })

    const res = await getThreads(wsReq('/api/workspaces/ws-1/threads'), { params: Promise.resolve({ id: 'ws-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.items).toHaveLength(1)
    expect(json.data.items[0].identifier).toBe('R-8821')
    expect(receivedPath).toBe('/api/v1/workspaces/ws-1/threads')
  })

  it('forwards the before cursor through to the gateway', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { items: [], nextBefore: null } }))
    })
    await getThreads(wsReq('/api/workspaces/ws-1/threads?before=2026-07-09T00:00:00.000Z&limit=20'), {
      params: Promise.resolve({ id: 'ws-1' }),
    })
    expect(receivedSearch).toBe('/api/v1/workspaces/ws-1/threads?before=2026-07-09T00:00:00.000Z&limit=20')
  })
})
