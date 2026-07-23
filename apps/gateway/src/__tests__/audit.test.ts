import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'
import { AppDataSource } from '@mil/db'

/**
 * Integration tests for audit logging (plan M6.6 / P1.4.T6; risk R15).
 *
 * Drives the gateway via `app.request()` against the real milagents Postgres
 * (the audit_log + token_meta tables), with a stub new-api server so the token
 * routes' upstream calls succeed. Each test wipes audit_log + token_meta so
 * assertions are on the rows this run wrote.
 *
 * Coverage:
 * - token create / update / delete each write an audit row with actor + action
 *   + target + run_id
 * - a caller-supplied x-run-id threads into the audit row (OTel correlation)
 * - a caller-supplied x-user-id / x-client-id sets the actor
 * - audit write failure never blocks the main operation (fire-and-forget)
 * - GET /api/v1/audit lists rows newest-first, filters by action/target/run_id,
 *   paginates with a nextBefore cursor
 * - GET /api/v1/audit validates query params (400 on bad enum / uuid)
 *
 * The scheduler's version-lock audit path is covered in
 * `apps/scheduler/src/__tests__/repro-integration.test.ts` (it asserts the
 * audit row lands alongside the snapshot). This file covers the gateway side.
 */

let stubServer: Server
let stubUrl = ''
type StubHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
let stubHandler: StubHandler = defaultHandler

function defaultHandler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    // new-api create/update/delete return { success: true }; list/get return
    // { success, data }. The audit path only cares that upstream.ok is true.
    res.end(JSON.stringify({ success: true, message: '', data: stubResponse(req) }))
  })
}

function stubResponse(req: import('node:http').IncomingMessage): unknown {
  const url = req.url ?? ''
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
  await AppDataSource.query(`DELETE FROM audit_log`)
  await AppDataSource.query(`DELETE FROM token_meta`)
})

/** Read the audit rows this run wrote, newest-first. */
async function auditRows(): Promise<Array<Record<string, unknown>>> {
  return AppDataSource.query(
    `SELECT actor_type, actor_id, action, target_type, target_id, run_id, detail, ip, user_agent
       FROM audit_log ORDER BY created_at DESC`,
  )
}

const JSON_HEADERS = { 'content-type': 'application/json' }

describe('token audit — POST/PUT/DELETE write audit rows', () => {
  it('POST /api/v1/tokens writes a token.create audit row with run_id + actor', async () => {
    const res = await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-run-id': 'run-create-1', 'x-user-id': 'user-42' },
      body: JSON.stringify({ name: 'new-tok', remain_quota: 1000, expired_time: -1 }),
    })
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'user',
      actor_id: 'user-42',
      action: 'token.create',
      target_type: 'token',
      run_id: 'run-create-1',
    })
    // detail carries the requested name (never the raw key)
    expect(rows[0].detail).toMatchObject({ name: 'new-tok' })
  })

  it('PUT /api/v1/tokens/:id writes a token.update audit row', async () => {
    const res = await app.request('/api/v1/tokens/44', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'x-run-id': 'run-update-1' },
      body: JSON.stringify({ name: 'renamed', remain_quota: 100, meta: { remark: 'prod key', visibility: 'private' } }),
    })
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'gateway',
      action: 'token.update',
      target_type: 'token',
      target_id: '44',
      run_id: 'run-update-1',
    })
    // detail captures the editorial fields touched (never the raw key)
    expect(rows[0].detail).toMatchObject({ remark: 'prod key', visibility: 'private' })
  })

  it('DELETE /api/v1/tokens/:id writes a token.delete audit row after the delete succeeds', async () => {
    // seed a token_meta row so the delete has something to drop locally
    await AppDataSource.query(
      `INSERT INTO token_meta (newapi_token_id, name, "group", status) VALUES (55, 'x', 'default', 'active')`,
    )
    const res = await app.request('/api/v1/tokens/55', {
      method: 'DELETE',
      headers: { 'x-run-id': 'run-delete-1', 'x-client-id': 'svc-rotator' },
    })
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'svc-rotator',
      action: 'token.delete',
      target_type: 'token',
      target_id: '55',
      run_id: 'run-delete-1',
    })
    // the local token_meta row is gone (the delete ran before the audit)
    const meta = await AppDataSource.query(`SELECT 1 FROM token_meta WHERE newapi_token_id = 55`)
    expect(meta).toHaveLength(0)
  })

  it('does NOT audit when the upstream op fails (audit only on success)', async () => {
    // upstream 5xx → renderUpstream collapses to 502, no audit row
    stubHandler = (_req, res) => {
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom' }))
    }
    try {
      const res = await app.request('/api/v1/tokens/77', {
        method: 'DELETE',
        headers: { 'x-run-id': 'run-fail-1' },
      })
      expect(res.status).toBe(502)
      const rows = await auditRows()
      expect(rows).toHaveLength(0)
    } finally {
      stubHandler = defaultHandler
    }
  })

  it('x-client-id is used as the actor when x-user-id is absent', async () => {
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-client-id': 'console-ui' },
      body: JSON.stringify({ name: 't' }),
    })
    const rows = await auditRows()
    expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: 'console-ui' })
  })

  it('run_id is null when no x-run-id header is supplied', async () => {
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 't' }),
    })
    const rows = await auditRows()
    expect(rows[0].run_id).toBeNull()
  })

  it('captures best-effort ip (x-forwarded-for) + user-agent', async () => {
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'user-agent': 'console/1.0 (test)',
      },
      body: JSON.stringify({ name: 't' }),
    })
    const rows = await auditRows()
    expect(rows[0].ip).toBe('203.0.113.7')
    expect(rows[0].user_agent).toBe('console/1.0 (test)')
  })
})

describe('audit fire-and-forget — a failed audit write never blocks the op', () => {
  it('returns 200 even when the audit INSERT would fail (table missing)', async () => {
    // Drop audit_log mid-test so the audit INSERT throws. The token op already
    // succeeded (upstream 200 + token_meta upsert), so the response must still
    // be 200 — the audit failure is swallowed + logged, never propagated.
    await AppDataSource.query(`DROP TABLE audit_log`)
    try {
      const res = await app.request('/api/v1/tokens', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-run-id': 'run-noop-1' },
        body: JSON.stringify({ name: 't' }),
      })
      expect(res.status).toBe(200)
    } finally {
      // recreate the table so afterEach / later tests aren't poisoned
      await AppDataSource.query(`
        CREATE TABLE "audit_log" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "actor_type" TEXT NOT NULL,
          "actor_id" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "target_type" TEXT NOT NULL,
          "target_id" TEXT NOT NULL,
          "run_id" TEXT,
          "workspace_id" UUID,
          "detail" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "ip" TEXT,
          "user_agent" TEXT,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT audit_log_actor_type_chk CHECK ("actor_type" IN ('user','system')),
          CONSTRAINT audit_log_target_type_chk CHECK ("target_type" IN ('token','pipeline_version'))
        )
      `)
      await AppDataSource.query(`CREATE INDEX idx_audit_log_created_at ON "audit_log" ("created_at")`)
      await AppDataSource.query(`CREATE INDEX idx_audit_log_actor ON "audit_log" ("actor_type", "actor_id")`)
      await AppDataSource.query(`CREATE INDEX idx_audit_log_target ON "audit_log" ("target_type", "target_id")`)
      await AppDataSource.query(`CREATE INDEX idx_audit_log_run_id ON "audit_log" ("run_id")`)
    }
  })
})

describe('GET /api/v1/audit — query endpoint', () => {
  it('lists audit rows newest-first in the standard envelope', async () => {
    // write two rows with distinct actions
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-run-id': 'r1' },
      body: JSON.stringify({ name: 'a' }),
    })
    await app.request('/api/v1/tokens/2', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'x-run-id': 'r2' },
      body: JSON.stringify({ name: 'b' }),
    })

    const res = await app.request('/api/v1/audit', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: Array<{ action: string; runId: string }>; nextBefore: string | null } }
    expect(body.success).toBe(true)
    expect(body.data.items).toHaveLength(2)
    // newest-first: the PUT (r2) was written after the POST (r1)
    expect(body.data.items[0].action).toBe('token.update')
    expect(body.data.items[0].runId).toBe('r2')
    expect(body.data.items[1].action).toBe('token.create')
    expect(body.data.items[1].runId).toBe('r1')
  })

  it('filters by action', async () => {
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ name: 'a' }),
    })
    await app.request('/api/v1/tokens/3', {
      method: 'PUT',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ name: 'b' }),
    })
    const res = await app.request('/api/v1/audit?action=token.update', { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ action: string }> } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].action).toBe('token.update')
  })

  it('filters by run_id', async () => {
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-run-id': 'run-specific' },
      body: JSON.stringify({ name: 'a' }),
    })
    await app.request('/api/v1/tokens', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-run-id': 'run-other' },
      body: JSON.stringify({ name: 'b' }),
    })
    const res = await app.request('/api/v1/audit?runId=run-specific', { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ runId: string }> } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].runId).toBe('run-specific')
  })

  it('filters by target_type + target_id', async () => {
    await app.request('/api/v1/tokens/88', {
      method: 'PUT',
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ name: 'b' }),
    })
    const res = await app.request('/api/v1/audit?targetType=token&targetId=88', { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ targetId: string }> } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].targetId).toBe('88')
  })

  it('paginates with limit + nextBefore cursor', async () => {
    // write 3 rows. Each POST resolves only after its audit row is written
    // (recordAudit is awaited on the create path), so by the time these
    // settle the rows exist in order.
    for (let i = 0; i < 3; i++) {
      await app.request('/api/v1/tokens', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-run-id': `page-${i}` },
        body: JSON.stringify({ name: `t${i}` }),
      })
    }
    // first page: limit=2 → 2 items + a nextBefore cursor
    const p1 = await app.request('/api/v1/audit?limit=2', { method: 'GET' })
    const b1 = (await p1.json()) as { data: { items: Array<{ runId: string }>; nextBefore: string } }
    expect(b1.data.items).toHaveLength(2)
    expect(b1.data.nextBefore).not.toBeNull()
    // second page: before=nextBefore → the remaining 1 item, nextBefore null
    const p2 = await app.request(`/api/v1/audit?limit=2&before=${encodeURIComponent(b1.data.nextBefore)}`, { method: 'GET' })
    const b2 = (await p2.json()) as { data: { items: Array<{ runId: string }>; nextBefore: string | null } }
    expect(b2.data.items).toHaveLength(1)
    expect(b2.data.nextBefore).toBeNull()
    // no overlap between pages
    const seen = new Set([...b1.data.items.map((i) => i.runId), ...b2.data.items.map((i) => i.runId)])
    expect(seen.size).toBe(3)
  })

  it('400s on an invalid query param (bad actorType enum)', async () => {
    const res = await app.request('/api/v1/audit?actorType=hacker', { method: 'GET' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'invalid query' })
  })

  it('400s on a non-uuid workspaceId', async () => {
    const res = await app.request('/api/v1/audit?workspaceId=not-a-uuid', { method: 'GET' })
    expect(res.status).toBe(400)
  })

  it('returns an empty page (not an error) when no rows match', async () => {
    const res = await app.request('/api/v1/audit?runId=nothing-here', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { items: unknown[]; nextBefore: string | null } }
    expect(body.data.items).toHaveLength(0)
    expect(body.data.nextBefore).toBeNull()
  })
})
