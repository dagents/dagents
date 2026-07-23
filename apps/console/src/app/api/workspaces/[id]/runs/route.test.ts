import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as postRun } from './route'
import { GET as getThreads } from '../threads/route'

/**
 * Integration tests for `POST /api/workspaces/[id]/runs` — the console proxy
 * that starts a new Workspace conversation turn by forwarding to the
 * scheduler's fan-out endpoint (M5b.1 / P1.10.T6).
 *
 * Mirrors the workspaces read-proxy tests: each route is a security boundary
 * that keeps the scheduler URL server-side and collapses a dial failure to a
 * sanitized 502. `SCHEDULER_URL` is repointed at a stub HTTP server (or a dead
 * port) per test. Coverage:
 *  - scheduler unreachable → 502 (fetch throws → sanitized envelope)
 *  - scheduler 200 → forwarded verbatim with content-type
 *  - scheduler non-2xx → forwarded as-is
 *  - the :id path segment is injected as `workspaceId` in the body (no spoof)
 *  - a caller-supplied workspaceId in the body is overwritten by the path id
 *  - x-run-id forwarded when well-formed
 *  - a malformed JSON body → 400 (not forwarded to the scheduler)
 *
 * Also re-checks the threads proxy still forwards the new (created_at, id)
 * compound cursor params (`before` + `beforeId`) to the gateway.
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
  process.env.SCHEDULER_URL = `http://127.0.0.1:${addr.port}`
}

afterEach(async () => {
  if (stub) {
    await new Promise<void>((r) => stub!.close(() => r()))
    stub = null
  }
  delete process.env.SCHEDULER_URL
  delete process.env.GATEWAY_URL
})

const WS_ID = 'c39c3aba-c9fb-4029-b7f4-eaedf285b2df'

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const ctx = (id: string = WS_ID) => ({ params: Promise.resolve({ id }) })

describe('POST /api/workspaces/[id]/runs — scheduler fan-out proxy', () => {
  it('returns 502 when the scheduler is unreachable', async () => {
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1'
    const res = await postRun(postReq({ flowId: 'f', inputs: [{ body: { question: 'hi' } }] }), ctx())
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('scheduler unavailable')
  })

  it('forwards a 200 scheduler response verbatim with content-type', async () => {
    const body = JSON.stringify({
      success: true,
      data: { parentRunId: 'run-1', total: 1, completed: 1, failed: 0, children: [], aggregate: { total: 1, completed: 1, failed: 0 } },
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

    const res = await postRun(
      postReq(
        { flowId: 'f', pipelineId: 'f', identifier: 't', inputs: [{ body: { question: 'hi' } }] },
        { 'x-run-id': 'run-ws-1', cookie: 'mil_session=tok-abc' },
      ),
      ctx(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.parentRunId).toBe('run-1')
    // forwards to the scheduler's fan-out path
    expect(receivedPath).toBe('/api/v1/scheduler/runs/fanout')
    expect(receivedRunId).toBe('run-ws-1')
    // M5b.4: the SSO session cookie is forwarded so the gateway's session
    // middleware sees the caller under REQUIRE_LOGIN=1 (HIGH#1 regression guard).
    expect(receivedCookie).toContain('mil_session=tok-abc')
  })

  it('forwards an upstream non-2xx as-is', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(502)
      res.end(JSON.stringify({ success: false, error: 'fanout failed', detail: 'inputs empty' }))
    })
    const res = await postRun(postReq({ flowId: 'f', inputs: [] }), ctx())
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('fanout failed')
  })

  it('injects the :id path segment as workspaceId (no cross-workspace spoof)', async () => {
    let receivedBody: Record<string, unknown> = {}
    await withStub((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, data: { parentRunId: 'r' } }))
      })
    })
    // caller tries to spoof a different workspaceId in the body
    await postRun(
      postReq({ flowId: 'f', pipelineId: 'f', identifier: 't', inputs: [{ body: {} }], workspaceId: 'evil-other-ws' }),
      ctx(),
    )
    expect(receivedBody.workspaceId).toBe(WS_ID)
  })

  it('overwrites a missing workspaceId with the path id', async () => {
    let receivedBody: Record<string, unknown> = {}
    await withStub((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, data: { parentRunId: 'r' } }))
      })
    })
    await postRun(postReq({ flowId: 'f', pipelineId: 'f', identifier: 't', inputs: [{ body: {} }] }), ctx())
    expect(receivedBody.workspaceId).toBe(WS_ID)
  })

  it('rejects a malformed JSON body with 400 (never reaches the scheduler)', async () => {
    let reached = false
    await withStub((_req, res) => {
      reached = true
      res.writeHead(200)
      res.end('{}')
    })
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await postRun(req, ctx())
    expect(res.status).toBe(400)
    expect(reached).toBe(false)
  })
})

describe('GET /api/workspaces/[id]/threads — forwards the compound cursor', () => {
  it('forwards before + beforeId through to the gateway', async () => {
    let receivedSearch = ''
    await withStub((req, res) => {
      receivedSearch = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { items: [], nextBefore: null, nextBeforeId: null } }))
    })
    // The threads proxy dials the GATEWAY_URL (not SCHEDULER_URL); repoint it
    // at the same stub so the dial succeeds and the forwarded query is visible.
    process.env.GATEWAY_URL = process.env.SCHEDULER_URL
    const req = new NextRequest(
      `http://localhost/api/workspaces/${WS_ID}/threads?before=2026-07-09T00:00:00.000Z&beforeId=11111111-1111-4111-8111-111111111111&limit=20`,
      { method: 'GET' },
    )
    await getThreads(req, ctx())
    expect(receivedSearch).toBe(
      `/api/v1/workspaces/${WS_ID}/threads?before=2026-07-09T00:00:00.000Z&beforeId=11111111-1111-4111-8111-111111111111&limit=20`,
    )
  })
})
