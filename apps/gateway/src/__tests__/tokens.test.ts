import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'
import { AppDataSource } from '@mil/db'
import {
  mapNewapiTokenStatus,
  adminRequestHeaders,
  NEWAPI_TOKEN_STATUS,
} from '../newapi.js'

/**
 * Integration tests for the new-api token proxy + local token_meta sync (M2.8).
 *
 * Spins up a stub HTTP server that emulates new-api's `/api/token/*` admin API,
 * points the gateway at it via NEWAPI_BASE_URL, and drives the gateway via
 * `app.request()`. Uses the real milagents Postgres (docker-compose on
 * 127.0.0.1:15432) for token_meta, wiping the table between tests.
 *
 * Coverage:
 * - GET /api/v1/tokens lists + syncs token_meta (masked keys pass through)
 * - GET /api/v1/tokens/:id fetches one + syncs meta
 * - POST creates (forwards payload, strips local `meta`)
 * - PUT /:id updates + applies `meta` to token_meta
 * - DELETE /:id removes + drops token_meta row
 * - admin auth injected (Authorization + New-Api-User); caller's stripped
 * - 503 when NEWAPI_ADMIN_KEY unset; 502 on upstream 5xx (no body leak)
 * - non-digit :id → 400 (no path traversal to new-api)
 */

let stubServer: Server
let stubUrl = ''
// latest request the stub received, for assertions.
let recorded: { lastReq: Request | null } = { lastReq: null }
type StubHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
let stubHandler: StubHandler = defaultHandler

function defaultHandler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    recorded.lastReq = new Request(
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'stub'}`),
      { method: req.method, headers: req.headers as Record<string, string>, body: raw || undefined },
    )
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify({ success: true, message: '', data: stubResponse(req) }))
  })
}

// Minimal new-api-shaped responses keyed by path/method.
function stubResponse(req: import('node:http').IncomingMessage): unknown {
  const url = req.url ?? ''
  if (url.startsWith('/api/token/?') || url === '/api/token/') {
    return {
      page: 1,
      page_size: 10,
      total: 2,
      items: [
        { id: 11, user_id: 1, key: 'AAAA**********aaaa', status: 1, name: 'tok-a', group: 'default', expired_time: -1, remain_quota: 1000, unlimited_quota: false },
        { id: 22, user_id: 1, key: 'BBBB**********bbbb', status: 2, name: 'tok-b', group: 'default', expired_time: -1, remain_quota: 0, unlimited_quota: false },
      ],
    }
  }
  const idMatch = url.match(/^\/api\/token\/(\d+)$/)
  if (idMatch) {
    return { id: Number(idMatch[1]), user_id: 1, key: 'CCCC**********cccc', status: 1, name: `tok-${idMatch[1]}`, group: 'default', expired_time: -1, remain_quota: 500, unlimited_quota: false }
  }
  return null
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.NEWAPI_BASE_URL = stubUrl
  process.env.NEWAPI_ADMIN_KEY = 'test-admin-key'
  process.env.NEWAPI_ADMIN_USER_ID = '1'
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  stubHandler = defaultHandler
  await AppDataSource.query(`DELETE FROM token_meta`)
})

afterEach(() => {
  recorded = { lastReq: null }
})

const recordedReq = (): Request | null => recorded.lastReq

describe('gateway tokens proxy — admin auth + path rewrite', () => {
  it('GET /api/v1/tokens forwards to /api/token/ with admin auth, strips caller auth', async () => {
    const res = await app.request('/api/v1/tokens?p=0', {
      method: 'GET',
      headers: { authorization: 'Bearer caller-sk-xxx', 'new-api-user': '999' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { total: number; items: Array<{ key: string }> } }
    expect(body.data.total).toBe(2)
    expect(body.data.items[0].key).toBe('AAAA**********aaaa')

    const upstream = recordedReq()!
    expect(upstream.url).toContain('/api/token/')
    // admin key injected as raw Authorization (new-api access-token form)
    expect(upstream.headers.get('authorization')).toBe('test-admin-key')
    expect(upstream.headers.get('new-api-user')).toBe('1')
    // caller's own auth/user stripped — no impersonation
    expect(upstream.headers.get('authorization')).not.toContain('caller')
  })

  it('503s when NEWAPI_ADMIN_KEY is unset (no 401 auth-shape leak)', async () => {
    const saved = process.env.NEWAPI_ADMIN_KEY
    delete process.env.NEWAPI_ADMIN_KEY
    try {
      const res = await app.request('/api/v1/tokens', { method: 'GET' })
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ success: false, error: 'token admin not configured' })
    } finally {
      process.env.NEWAPI_ADMIN_KEY = saved
    }
  })

  it('rejects a non-digit token id (no path traversal to new-api)', async () => {
    const res = await app.request('/api/v1/tokens/../channel/1', { method: 'GET' })
    // hono normalizes ../ so this lands on /api/v1/channel/1 → 404; the point
    // is it never reaches new-api. Use a direct non-digit id for the 400 path.
    expect([400, 404]).toContain(res.status)
    expect(recordedReq()).toBeNull()
  })

  it('400s on a non-numeric :id for get/update/delete', async () => {
    const res = await app.request('/api/v1/tokens/not-a-number', { method: 'GET' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'invalid token id' })
    expect(recordedReq()).toBeNull()
  })

  it('collapses an upstream 5xx to a sanitized 502 (no body leak)', async () => {
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-internal', 'newapi-host-1234')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom', stack: 'at /internal/…', db: 'postgres://u:p@host' }))
    }
    try {
      const res = await app.request('/api/v1/tokens', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'upstream error' })
      expect(JSON.stringify(body)).not.toContain('stack')
      expect(JSON.stringify(body)).not.toContain('postgres://')
      expect(res.headers.get('x-internal')).toBeNull()
    } finally {
      stubHandler = defaultHandler
    }
  })
})

describe('gateway tokens proxy — token_meta sync', () => {
  it('GET list upserts a token_meta row per item (id, name, group; no key)', async () => {
    await app.request('/api/v1/tokens?p=0', { method: 'GET' })
    const rows = await AppDataSource.query(
      `SELECT newapi_token_id, name, "group", status FROM token_meta ORDER BY newapi_token_id`,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ newapi_token_id: '11', name: 'tok-a', group: 'default', status: 'unknown' })
    expect(rows[1]).toMatchObject({ newapi_token_id: '22', name: 'tok-b' })
    // the raw key is never persisted — only the int newapi_token_id
    const keyCols = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'token_meta'`,
    )
    expect(keyCols.map((c: { column_name: string }) => c.column_name)).not.toContain('key')
  })

  it('GET /:id upserts a token_meta row for that id', async () => {
    await app.request('/api/v1/tokens/33', { method: 'GET' })
    const rows = await AppDataSource.query(
      `SELECT newapi_token_id, name FROM token_meta WHERE newapi_token_id = 33`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ newapi_token_id: '33', name: 'tok-33' })
  })

  it('PUT /:id with meta applies remark/visibility to token_meta', async () => {
    await app.request('/api/v1/tokens/44', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed', remain_quota: 100, meta: { remark: 'prod key', visibility: 'private' } }),
    })
    const rows = await AppDataSource.query(
      `SELECT name, remark, visibility FROM token_meta WHERE newapi_token_id = 44`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'tok-44', remark: 'prod key', visibility: 'private' })
  })

  it('DELETE /:id drops the token_meta row', async () => {
    await AppDataSource.query(
      `INSERT INTO token_meta (newapi_token_id, name, "group", status) VALUES (55, 'x', 'default', 'active')`,
    )
    const res = await app.request('/api/v1/tokens/55', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const rows = await AppDataSource.query(`SELECT 1 FROM token_meta WHERE newapi_token_id = 55`)
    expect(rows).toHaveLength(0)
  })

  it('POST strips local `meta` before forwarding to new-api', async () => {
    const res = await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new-tok', remain_quota: 1000, expired_time: -1, meta: { remark: 'local-only' } }),
    })
    expect(res.status).toBe(200)
    const upstream = recordedReq()!
    const forwarded = JSON.parse(await upstream.text())
    expect(forwarded.name).toBe('new-tok')
    expect(forwarded.meta).toBeUndefined()
  })
})

describe('mapNewapiTokenStatus', () => {
  it('maps enabled + quota → active', () => {
    expect(mapNewapiTokenStatus({ status: 1, expired_time: -1, remain_quota: 100, unlimited_quota: false })).toBe('active')
  })
  it('re-derives expired from expired_time even when status=1', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    expect(mapNewapiTokenStatus({ status: 1, expired_time: past, remain_quota: 100, unlimited_quota: false })).toBe('expired')
  })
  it('re-derives exhausted from remain_quota=0 even when status=1', () => {
    expect(mapNewapiTokenStatus({ status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: false })).toBe('exhausted')
  })
  it('unlimited quota is never exhausted', () => {
    expect(mapNewapiTokenStatus({ status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true })).toBe('active')
  })
  it('maps new-api status=2 → disabled, 3 → expired, 4 → exhausted', () => {
    expect(mapNewapiTokenStatus({ status: NEWAPI_TOKEN_STATUS.DISABLED, expired_time: -1, remain_quota: 100, unlimited_quota: false })).toBe('disabled')
    expect(mapNewapiTokenStatus({ status: NEWAPI_TOKEN_STATUS.EXPIRED, expired_time: -1, remain_quota: 100, unlimited_quota: false })).toBe('expired')
    expect(mapNewapiTokenStatus({ status: NEWAPI_TOKEN_STATUS.EXHAUSTED, expired_time: -1, remain_quota: 100, unlimited_quota: false })).toBe('exhausted')
  })
})

describe('adminRequestHeaders', () => {
  it('drops hop-by-hop + caller auth, injects admin auth', () => {
    const inbound = new Headers({
      host: 'gateway.example',
      connection: 'keep-alive',
      authorization: 'Bearer caller-sk',
      'new-api-user': '999',
      'x-custom': 'keep-me',
    })
    const out = adminRequestHeaders(inbound, 'application/json')
    expect(out.get('authorization')).toBe('test-admin-key')
    expect(out.get('new-api-user')).toBe('1')
    expect(out.get('host')).toBeNull()
    expect(out.get('connection')).toBeNull()
    expect(out.get('x-custom')).toBe('keep-me')
    expect(out.get('content-type')).toBe('application/json')
  })
})
