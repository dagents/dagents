import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource } from '@dagents/db'
import { randomUUID } from 'node:crypto'

/**
 * Integration tests for audit logging (plan M6.6 / P1.4.T6; risk R15).
 *
 * Drives the gateway via `app.request()` against the real dagents Postgres
 * (the audit_log + llm_providers tables). Each test wipes audit_log + llm_providers
 * so assertions are on the rows this run wrote.
 *
 * Coverage:
 * - llm provider create / update / delete each write an audit row with actor + action
 *   + target + run_id
 * - a caller-supplied x-run-id threads into the audit row (OTel correlation)
 * - a caller-supplied x-user-id / x-client-id sets the actor
 * - audit write failure never blocks the main operation (fire-and-forget)
 * - GET /api/v1/audit lists rows newest-first, filters by action/target/run_id,
 *   paginates with a nextBefore cursor
 * - GET /api/v1/audit validates query params (400 on bad enum / uuid)
 *
 * This file covers the gateway side. The version-lock audit path was
 * historically covered by scheduler integration tests (scheduler + repro
 * removed 2026-08-01); the gateway now owns audit writing.
 */

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  await AppDataSource.query(`DELETE FROM audit_log`)
  await AppDataSource.query(`DELETE FROM llm_providers`)
})

/** Read the audit rows this run wrote, newest-first. */
async function auditRows(): Promise<Array<Record<string, unknown>>> {
  return AppDataSource.query(
    `SELECT actor_type, actor_id, action, target_type, target_id, run_id, detail, ip, user_agent
       FROM audit_log ORDER BY created_at DESC`,
  )
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function createTestProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-provider',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test12345678',
    defaultModel: 'gpt-4',
    ...overrides,
  }
}

async function createProvider(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ id: string; res: Response }> {
  const body = createTestProvider(overrides)
  const res = await app.request('/api/v1/llm-providers', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { success: boolean; data: { provider: { id: string } } }
  return { id: data.data.provider.id, res }
}

describe('llm provider audit — POST/PATCH/DELETE write audit rows', () => {
  it('POST /api/v1/llm-providers writes a llm_provider.create audit row with run_id + actor', async () => {
    const { res } = await createProvider(
      { name: 'new-provider' },
      { 'x-run-id': 'run-create-1', 'x-user-id': 'user-42' },
    )
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'user',
      actor_id: 'user-42',
      action: 'llm_provider.create',
      target_type: 'llm_provider',
      run_id: 'run-create-1',
    })
    expect(rows[0].detail).toMatchObject({ name: 'new-provider' })
  })

  it('PATCH /api/v1/llm-providers/:id writes a llm_provider.update audit row', async () => {
    const { id } = await createProvider({}, { 'x-run-id': 'run-update-1' })

    const res = await app.request(`/api/v1/llm-providers/${id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'x-run-id': 'run-update-2' },
      body: JSON.stringify({ name: 'renamed', status: 'disabled', remark: 'prod key' }),
    })
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'gateway',
      action: 'llm_provider.update',
      target_type: 'llm_provider',
      target_id: id,
      run_id: 'run-update-2',
    })
    expect(rows[0].detail).toMatchObject({ name: 'renamed', status: 'disabled', remark: 'prod key' })
  })

  it('DELETE /api/v1/llm-providers/:id writes a llm_provider.delete audit row after the delete succeeds', async () => {
    const { id } = await createProvider({}, { 'x-client-id': 'svc-rotator' })

    const res = await app.request(`/api/v1/llm-providers/${id}`, {
      method: 'DELETE',
      headers: { 'x-run-id': 'run-delete-1', 'x-client-id': 'svc-rotator' },
    })
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: 'svc-rotator',
      action: 'llm_provider.delete',
      target_type: 'llm_provider',
      target_id: id,
      run_id: 'run-delete-1',
    })
    const providers = await AppDataSource.query(`SELECT 1 FROM llm_providers WHERE id = $1`, [id])
    expect(providers).toHaveLength(0)
  })

  it('does NOT audit when the op fails (audit only on success)', async () => {
    const fakeId = randomUUID()
    const res = await app.request(`/api/v1/llm-providers/${fakeId}`, {
      method: 'DELETE',
      headers: { 'x-run-id': 'run-fail-1' },
    })
    expect(res.status).toBe(404)
    const rows = await auditRows()
    expect(rows).toHaveLength(0)
  })

  it('x-client-id is used as the actor when x-user-id is absent', async () => {
    await createProvider({}, { 'x-client-id': 'console-ui' })
    const rows = await auditRows()
    expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: 'console-ui' })
  })

  it('run_id is null when no x-run-id header is supplied', async () => {
    await createProvider()
    const rows = await auditRows()
    expect(rows[0].run_id).toBeNull()
  })

  it('captures best-effort ip (x-forwarded-for) + user-agent', async () => {
    await createProvider({}, {
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      'user-agent': 'console/1.0 (test)',
    })
    const rows = await auditRows()
    expect(rows[0].ip).toBe('203.0.113.7')
    expect(rows[0].user_agent).toBe('console/1.0 (test)')
  })
})

describe('audit fire-and-forget — a failed audit write never blocks the op', () => {
  it('returns 200 even when the audit INSERT would fail (table missing)', async () => {
    await AppDataSource.query(`DROP TABLE audit_log`)
    try {
      const { res } = await createProvider({}, { 'x-run-id': 'run-noop-1' })
      expect(res.status).toBe(200)
    } finally {
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
          CONSTRAINT audit_log_target_type_chk CHECK ("target_type" IN ('token','pipeline_version','llm_provider','workflow','agent','chat'))
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
    const { id } = await createProvider({ name: 'a' }, { 'x-run-id': 'r1' })
    await app.request(`/api/v1/llm-providers/${id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'x-run-id': 'r2' },
      body: JSON.stringify({ name: 'b' }),
    })

    const res = await app.request('/api/v1/audit', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: Array<{ action: string; runId: string }>; nextBefore: string | null } }
    expect(body.success).toBe(true)
    expect(body.data.items).toHaveLength(2)
    expect(body.data.items[0].action).toBe('llm_provider.update')
    expect(body.data.items[0].runId).toBe('r2')
    expect(body.data.items[1].action).toBe('llm_provider.create')
    expect(body.data.items[1].runId).toBe('r1')
  })

  it('filters by action', async () => {
    const { id } = await createProvider({ name: 'a' })
    await app.request(`/api/v1/llm-providers/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'b' }),
    })
    const res = await app.request('/api/v1/audit?action=llm_provider.update', { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ action: string }> } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].action).toBe('llm_provider.update')
  })

  it('filters by run_id', async () => {
    await createProvider({ name: 'a' }, { 'x-run-id': 'run-specific' })
    await createProvider({ name: 'b' }, { 'x-run-id': 'run-other' })
    const res = await app.request('/api/v1/audit?runId=run-specific', { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ runId: string }> } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].runId).toBe('run-specific')
  })

  it('filters by target_type + target_id', async () => {
    const { id } = await createProvider({ name: 'b' })
    const res = await app.request(`/api/v1/audit?targetType=llm_provider&targetId=${id}`, { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ targetId: string }> } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0].targetId).toBe(id)
  })

  it('paginates with limit + nextBefore cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await createProvider({ name: `t${i}` }, { 'x-run-id': `page-${i}` })
    }
    const p1 = await app.request('/api/v1/audit?limit=2', { method: 'GET' })
    const b1 = (await p1.json()) as { data: { items: Array<{ runId: string }>; nextBefore: string } }
    expect(b1.data.items).toHaveLength(2)
    expect(b1.data.nextBefore).not.toBeNull()
    const p2 = await app.request(`/api/v1/audit?limit=2&before=${encodeURIComponent(b1.data.nextBefore)}`, { method: 'GET' })
    const b2 = (await p2.json()) as { data: { items: Array<{ runId: string }>; nextBefore: string | null } }
    expect(b2.data.items).toHaveLength(1)
    expect(b2.data.nextBefore).toBeNull()
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
