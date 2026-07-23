import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as listSessions, POST as createSession } from './route'
import { GET as getSession, PATCH as patchSession } from './[id]/route'
import { GET as listMessages, POST as appendMessage } from './[id]/messages/route'

/**
 * Integration tests for the `/api/lab/*` proxies (M5b.2 / P1.10.T7).
 *
 * Mirrors `api/workspaces/route.test.ts`: each route is a security boundary
 * that keeps the gateway URL server-side and collapses a dial failure to a
 * 502 the view surfaces. `GATEWAY_URL` is repointed at a stub HTTP server (or
 * a dead port) per test. Coverage:
 *  - gateway unreachable → 502 (fetch throws → sanitized envelope)
 *  - gateway 200 + JSON envelope → forwarded verbatim with content-type
 *  - gateway non-2xx → forwarded as-is (status + body)
 *  - the :id segment is encoded into the upstream path
 *  - x-run-id forwarded when well-formed (so an append pins the trace)
 *  - POST forwards the JSON body verbatim to the gateway
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let stub: Server | null = null
let stubUrl = ''

/** Spin up a stub gateway on an ephemeral port and point the route at it. */
async function withStub(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<void> {
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

function labReq(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
  })
}

describe('GET /api/lab/sessions', () => {
  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await listSessions(labReq('/api/lab/sessions'))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })

  it('forwards a 200 session list verbatim with content-type', async () => {
    const body = JSON.stringify({
      success: true,
      data: { items: [{ id: 's1', name: 'RL 复现', status: 'running', agentsCount: 4, messageCount: 9 }] },
    })
    let receivedPath = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(body)
    })
    const res = await listSessions(labReq('/api/lab/sessions?status=running'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.text()).toBe(body)
    // query string forwarded to the gateway
    expect(receivedPath).toBe('/api/v1/lab/sessions?status=running')
  })

  it('forwards an upstream non-2xx as-is', async () => {
    await withStub((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(400)
      res.end(JSON.stringify({ success: false, error: 'invalid query' }))
    })
    const res = await listSessions(labReq('/api/lab/sessions?status=bogus'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
  })
})

describe('POST /api/lab/sessions', () => {
  it('forwards the JSON body verbatim to the gateway and returns the created row', async () => {
    const reqBody = JSON.stringify({ name: '新实验', mode: 'auto' })
    const respBody = JSON.stringify({
      success: true,
      data: { session: { id: 's2', name: '新实验', status: 'running', mode: 'auto' } },
    })
    let receivedBody = ''
    let receivedMethod = ''
    await withStub((req, res) => {
      receivedMethod = req.method ?? ''
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(respBody)
      })
    })
    const res = await createSession(labReq('/api/lab/sessions', { method: 'POST', body: reqBody }))
    expect(res.status).toBe(200)
    expect(receivedMethod).toBe('POST')
    expect(receivedBody).toBe(reqBody)
    expect(await res.text()).toBe(respBody)
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await createSession(
      labReq('/api/lab/sessions', { method: 'POST', body: JSON.stringify({ name: 'x' }) }),
    )
    expect(res.status).toBe(502)
  })
})

describe('GET /api/lab/sessions/[id]', () => {
  it('encodes the :id segment into the upstream path', async () => {
    let receivedPath = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { session: {}, messages: [] } }))
    })
    const id = '11111111-1111-4111-8111-111111111111'
    const res = await getSession(labReq(`/api/lab/sessions/${id}`), {
      params: Promise.resolve({ id }),
    })
    expect(res.status).toBe(200)
    expect(receivedPath).toBe(`/api/v1/lab/sessions/${id}`)
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await getSession(labReq('/api/lab/sessions/11111111-1111-4111-8111-111111111111'), {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    })
    expect(res.status).toBe(502)
  })
})

describe('PATCH /api/lab/sessions/[id]', () => {
  it('forwards the PATCH body verbatim to the gateway', async () => {
    const reqBody = JSON.stringify({ mode: 'assist' })
    let receivedMethod = ''
    let receivedBody = ''
    let receivedPath = ''
    await withStub((req, res) => {
      receivedMethod = req.method ?? ''
      receivedPath = req.url ?? ''
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(
          JSON.stringify({
            success: true,
            data: { session: { id: 's1', mode: 'assist', status: 'running' } },
          }),
        )
      })
    })
    const id = '11111111-1111-4111-8111-111111111111'
    const res = await patchSession(
      labReq(`/api/lab/sessions/${id}`, { method: 'PATCH', body: reqBody }),
      { params: Promise.resolve({ id }) },
    )
    expect(res.status).toBe(200)
    expect(receivedMethod).toBe('PATCH')
    expect(receivedPath).toBe(`/api/v1/lab/sessions/${id}`)
    expect(receivedBody).toBe(reqBody)
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await patchSession(
      labReq('/api/lab/sessions/11111111-1111-4111-8111-111111111111', {
        method: 'PATCH',
        body: JSON.stringify({ mode: 'assist' }),
      }),
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    )
    expect(res.status).toBe(502)
  })
})

describe('GET /api/lab/sessions/[id]/messages', () => {
  it('forwards the paginated thread path + query', async () => {
    let receivedPath = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { items: [], nextBefore: null } }))
    })
    const id = '22222222-2222-4222-8222-222222222222'
    const res = await listMessages(labReq(`/api/lab/sessions/${id}/messages?limit=50`), {
      params: Promise.resolve({ id }),
    })
    expect(res.status).toBe(200)
    expect(receivedPath).toBe(`/api/v1/lab/sessions/${id}/messages?limit=50`)
  })
})

describe('POST /api/lab/sessions/[id]/messages', () => {
  it('forwards the body + x-run-id so the append pins the trace', async () => {
    const reqBody = JSON.stringify({ role: 'human', body: '介入一下' })
    let receivedBody = ''
    let receivedRunId = ''
    let receivedPath = ''
    await withStub((req, res) => {
      receivedPath = req.url ?? ''
      const rid = req.headers['x-run-id']
      receivedRunId = Array.isArray(rid) ? (rid[0] ?? '') : (rid ?? '')
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        res.setHeader('content-type', 'application/json')
        res.writeHead(200)
        res.end(
          JSON.stringify({
            success: true,
            data: { message: { id: 'm1', role: 'human', body: '介入一下', runId: 'run-xyz' } },
          }),
        )
      })
    })
    const id = '33333333-3333-4333-8333-333333333333'
    const res = await appendMessage(
      labReq(`/api/lab/sessions/${id}/messages`, {
        method: 'POST',
        body: reqBody,
        headers: { 'x-run-id': 'run-xyz' },
      }),
      { params: Promise.resolve({ id }) },
    )
    expect(res.status).toBe(200)
    expect(receivedPath).toBe(`/api/v1/lab/sessions/${id}/messages`)
    expect(receivedBody).toBe(reqBody)
    // x-run-id forwarded so the gateway pins it into the lab_messages row
    expect(receivedRunId).toBe('run-xyz')
  })

  it('returns 502 when the gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await appendMessage(
      labReq('/api/lab/sessions/33333333-3333-4333-8333-333333333333/messages', {
        method: 'POST',
        body: JSON.stringify({ role: 'human', body: 'x' }),
      }),
      { params: Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' }) },
    )
    expect(res.status).toBe(502)
  })
})
