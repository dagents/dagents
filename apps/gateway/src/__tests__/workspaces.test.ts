import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@mil/db'
import { randomUUID } from 'node:crypto'

/**
 * Integration tests for the workspace read API (M5b.1 / P1.10.T6).
 *
 * Drives the gateway via `app.request()` against the real milagents Postgres
 * (the workspaces / workspace_members / workspace_flows / runs tables), with a
 * stub Flowise server so the linked-flow enrich path resolves (or degrades).
 * Each test seeds its own workspace + members + flows + runs, then wipes them
 * so assertions are on the rows this test wrote.
 *
 * Coverage:
 * - GET / list returns active workspaces with member/flow counts, hides archived
 * - GET /:id returns the workspace + members + flows + artifact counts; 400 on
 *   a malformed id, 404 when no row matches
 * - GET /:id/threads returns runs scoped to the workspace newest-first; filters
 *   out fan-out children (parent_run_id IS NOT NULL); the (created_at, id)
 *   compound cursor pages without dropping same-ms runs
 * - GET /:id/quota returns the normalized quota blob; 404 when missing
 * - a Flowise enrich failure degrades a linked flow to `unknown` (no blank)
 * - a DB query failure collapses to a sanitized 502 (no stack leak)
 */

let stubServer: Server
let stubUrl = ''
type StubHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => void
let stubHandler: StubHandler = defaultFlowiseHandler

// Minimal Flowise chatflow row the gateway's `flowiseChatflowSchema` accepts.
function defaultFlowiseHandler(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  const url = req.url ?? ''
  const idMatch = url.match(/^\/api\/v1\/chatflows\/([^/?]+)/)
  res.setHeader('content-type', 'application/json')
  if (idMatch) {
    res.writeHead(200)
    res.end(
      JSON.stringify({
        id: idMatch[1],
        name: `flow-${idMatch[1]}`,
        type: 'AGENTFLOW',
        deployed: true,
        createdDate: '2026-07-01T00:00:00.000Z',
        updatedDate: '2026-07-09T00:00:00.000Z',
      }),
    )
    return
  }
  res.writeHead(404)
  res.end(JSON.stringify({ success: false, error: 'not found' }))
}

beforeAll(async () => {
  stubServer = createServer((req, res) => stubHandler(req, res))
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  const addr = stubServer.address() as AddressInfo
  stubUrl = `http://127.0.0.1:${addr.port}`
  process.env.FLOWISE_URL = stubUrl
  process.env.FLOWISE_API_KEY = 'flowise-key-123'
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  await new Promise<void>((r) => stubServer.close(() => r()))
  delete process.env.FLOWISE_URL
  delete process.env.FLOWISE_API_KEY
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(() => {
  stubHandler = defaultFlowiseHandler
})

afterEach(async () => {
  stubHandler = defaultFlowiseHandler
  await cleanupSeeded()
})

// Track the ids this test seeded so afterEach can wipe just them (not the
// shared dev rows other suites rely on). Cleared after each wipe.
let seededWorkspaceIds: string[] = []

async function cleanupSeeded(): Promise<void> {
  if (seededWorkspaceIds.length === 0) {
    // Still wipe any stray runs a test wrote outside a seeded workspace guard,
    // so a failed test doesn't leak rows into the next. Only touch runs whose
    // workspace_id matches a seed — never the shared dev runs.
    await runQuery(`DELETE FROM runs WHERE workspace_id = ANY($1::text[])`, [
      seededWorkspaceIds,
    ])
    return
  }
  await runQuery(`DELETE FROM runs WHERE workspace_id = ANY($1::text[])`, [
    seededWorkspaceIds,
  ])
  // workspace_members + workspace_flows cascade on workspace delete (ON DELETE
  // CASCADE in the migration), so dropping the workspaces cleans the rest.
  await runQuery(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [
    seededWorkspaceIds,
  ])
  seededWorkspaceIds = []
}

interface SeedOpts {
  name?: string
  status?: 'active' | 'archived'
  quota?: unknown
  members?: Array<{ memberId: string; role: string; displayName?: string; initial?: string }>
  flows?: Array<{ pipelineId: string; note?: string }>
}

/** Insert a workspace (+ members + flows) and remember its id for cleanup. */
async function seedWorkspace(opts: SeedOpts = {}): Promise<string> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO workspaces (id, name, description, owner_user_id, status, quota, glyph)
     VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
    [
      id,
      opts.name ?? `ws-${id.slice(0, 8)}`,
      null,
      opts.status ?? 'active',
      JSON.stringify(opts.quota ?? {}),
      (opts.name ?? 'W').slice(0, 1).toUpperCase(),
    ],
  )
  for (const m of opts.members ?? []) {
    await runQuery(
      `INSERT INTO workspace_members (workspace_id, member_id, display_name, initial, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, m.memberId, m.displayName ?? null, m.initial ?? null, m.role],
    )
  }
  for (const f of opts.flows ?? []) {
    await runQuery(
      `INSERT INTO workspace_flows (workspace_id, pipeline_id, note) VALUES ($1, $2, $3)`,
      [id, f.pipelineId, f.note ?? null],
    )
  }
  seededWorkspaceIds.push(id)
  return id
}

/** Insert a run scoped to a workspace (parent_run_id null by default). */
async function seedRun(
  workspaceId: string,
  partial: {
    identifier?: string
    pipelineId?: string
    status?: string
    input?: unknown
    output?: unknown
    artifactUri?: string | null
    parentRunId?: string | null
    createdAt?: Date
  } = {},
): Promise<string> {
  const id = randomUUID()
  // `created_at` is injected explicitly so same-ms pagination tests are
  // deterministic; otherwise NOW() collides for rows inserted in the same tick.
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, parent_run_id, input, output,
                       artifact_uri, workspace_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      partial.identifier ?? `R-${id.slice(0, 8)}`,
      partial.pipelineId ?? 'flow-1',
      partial.status ?? 'completed',
      partial.parentRunId ?? null,
      JSON.stringify(partial.input ?? {}),
      partial.output === undefined ? null : JSON.stringify(partial.output),
      partial.artifactUri ?? null,
      workspaceId,
      partial.createdAt ?? new Date(),
    ],
  )
  return id
}

describe('GET /api/v1/workspaces — list', () => {
  it('returns active workspaces with member + flow counts, newest-first', async () => {
    const a = await seedWorkspace({ name: 'List A', members: [{ memberId: 'u1', role: 'owner' }], flows: [{ pipelineId: 'fa' }] })
    const b = await seedWorkspace({ name: 'List B', members: [{ memberId: 'u1', role: 'owner' }, { memberId: 'u2', role: 'viewer' }] })

    const res = await app.request('/api/v1/workspaces', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: Array<{ name: string; memberCount: number; flowCount: number }> } }
    expect(body.success).toBe(true)
    const names = body.data.items.map((i) => i.name)
    // both seeded workspaces present (among the shared dev rows)
    expect(names).toContain('List A')
    expect(names).toContain('List B')
    const aRow = body.data.items.find((i) => i.name === 'List A')!
    expect(aRow.memberCount).toBe(1)
    expect(aRow.flowCount).toBe(1)
    const bRow = body.data.items.find((i) => i.name === 'List B')!
    expect(bRow.memberCount).toBe(2)
    expect(bRow.flowCount).toBe(0)
    // newest-first: B (seeded after A) appears before A
    expect(names.indexOf('List B')).toBeLessThan(names.indexOf('List A'))
    void a
    void b
  })

  it('hides archived projects by default; includeArchived=true surfaces them', async () => {
    const archived = await seedWorkspace({ name: 'Archived One', status: 'archived' })

    const base = (await (await app.request('/api/v1/workspaces', { method: 'GET' })).json()) as {
      data: { items: Array<{ name: string }> }
    }
    expect(base.data.items.map((i) => i.name)).not.toContain('Archived One')

    const withArchived = (await (await app.request('/api/v1/workspaces?includeArchived=true', { method: 'GET' })).json()) as {
      data: { items: Array<{ name: string }> }
    }
    expect(withArchived.data.items.map((i) => i.name)).toContain('Archived One')
    void archived
  })

  it('rejects an out-of-range limit with 400', async () => {
    const res = await app.request('/api/v1/workspaces?limit=9999', { method: 'GET' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/workspaces/:id — detail', () => {
  it('returns the workspace + members + flows + artifact counts', async () => {
    const id = await seedWorkspace({
      name: 'Detail WS',
      quota: { cost: { used: 10, cap: 100, unit: 'USD' } },
      members: [{ memberId: 'u_rz', role: 'owner', displayName: '饶哲', initial: 'RZ' }],
      flows: [{ pipelineId: 'flow_repro_01', note: 'repro line' }],
    })
    // one run with a .csv artifact (dataset), one with .patch (patch), one with no artifact
    await seedRun(id, { artifactUri: 's3://mil/runs/r1/data.csv', output: { text: 'ok' } })
    await seedRun(id, { artifactUri: 's3://mil/runs/r2/fix.patch' })
    await seedRun(id, { output: { text: 'no artifact' } })

    const res = await app.request(`/api/v1/workspaces/${id}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        workspace: { name: string; quota: { cost?: { used: number; cap: number; unit?: string } } }
        members: Array<{ memberId: string; role: string; displayName: string | null }>
        flows: Array<{ pipelineId: string; name: string; status: string; note: string | null }>
        artifacts: { reports: number; datasets: number; patches: number }
      }
    }
    expect(body.success).toBe(true)
    expect(body.data.workspace.name).toBe('Detail WS')
    expect(body.data.workspace.quota.cost?.used).toBe(10)
    expect(body.data.members[0]!.memberId).toBe('u_rz')
    // Flowise stub resolves the flow name + idle status
    expect(body.data.flows[0]!.pipelineId).toBe('flow_repro_01')
    expect(body.data.flows[0]!.name).toBe('flow-flow_repro_01')
    expect(body.data.flows[0]!.status).toBe('idle')
    // .csv → dataset, .patch → patch, the no-artifact run counts as nothing
    expect(body.data.artifacts).toEqual({ reports: 0, datasets: 1, patches: 1 })
  })

  it('400s on a malformed id (not a 404)', async () => {
    const res = await app.request('/api/v1/workspaces/not-a-uuid', { method: 'GET' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'invalid workspace id' })
  })

  it('404s when no workspace matches', async () => {
    const missing = randomUUID()
    const res = await app.request(`/api/v1/workspaces/${missing}`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('degrades a linked flow to unknown when Flowise is unreachable', async () => {
    const id = await seedWorkspace({ name: 'Degraded', flows: [{ pipelineId: 'flow_x' }] })
    // Flowise returns 502 for this flow → enrich degrades to unknown
    stubHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'boom' }))
    }
    const res = await app.request(`/api/v1/workspaces/${id}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { flows: Array<{ pipelineId: string; name: string; status: string }> } }
    expect(body.data.flows[0]!.name).toBe('flow_x')
    expect(body.data.flows[0]!.status).toBe('unknown')
  })

  it('does not count runs without an artifact_uri toward artifact totals', async () => {
    const id = await seedWorkspace({ name: 'NoArtifacts' })
    // three completed runs, none archived → zero artifacts of every kind
    await seedRun(id, { output: { text: 'a' } })
    await seedRun(id, { output: { text: 'b' } })
    await seedRun(id, { output: { text: 'c' } })
    const res = await app.request(`/api/v1/workspaces/${id}`, { method: 'GET' })
    const body = (await res.json()) as { data: { artifacts: { reports: number; datasets: number; patches: number } } }
    expect(body.data.artifacts).toEqual({ reports: 0, datasets: 0, patches: 0 })
  })
})

describe('GET /api/v1/workspaces/:id/threads — conversation thread', () => {
  it('returns runs scoped to the workspace, newest-first', async () => {
    const id = await seedWorkspace({ name: 'Thread WS' })
    const t0 = new Date('2026-07-08T10:00:00.000Z')
    const t1 = new Date('2026-07-09T10:00:00.000Z')
    await seedRun(id, { identifier: 'OLD', input: { question: 'old' }, createdAt: t0 })
    await seedRun(id, { identifier: 'NEW', input: { question: 'new' }, createdAt: t1 })

    const res = await app.request(`/api/v1/workspaces/${id}/threads`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { items: Array<{ identifier: string }>; nextBefore: string | null; nextBeforeId: string | null } }
    expect(body.success).toBe(true)
    expect(body.data.items.map((i) => i.identifier)).toEqual(['NEW', 'OLD'])
    expect(body.data.nextBefore).toBeNull()
    expect(body.data.nextBeforeId).toBeNull()
  })

  it('excludes fan-out children (parent_run_id IS NOT NULL)', async () => {
    const id = await seedWorkspace({ name: 'Fanout WS' })
    const parentId = await seedRun(id, { identifier: 'PARENT', input: { flowId: 'f', inputs: [] }, createdAt: new Date('2026-07-09T10:00:00.000Z') })
    await seedRun(id, { identifier: 'CHILD-1', parentRunId: parentId, input: { question: 'c1' }, createdAt: new Date('2026-07-09T10:00:01.000Z') })
    await seedRun(id, { identifier: 'CHILD-2', parentRunId: parentId, input: { question: 'c2' }, createdAt: new Date('2026-07-09T10:00:02.000Z') })

    const res = await app.request(`/api/v1/workspaces/${id}/threads`, { method: 'GET' })
    const body = (await res.json()) as { data: { items: Array<{ identifier: string }> } }
    // only the parent surfaces; children are filtered out
    expect(body.data.items.map((i) => i.identifier)).toEqual(['PARENT'])
  })

  it('pages with the (created_at, id) compound cursor without dropping same-ms runs', async () => {
    const id = await seedWorkspace({ name: 'Page WS' })
    // Insert 3 runs at the SAME millisecond to stress the tiebreaker. A
    // plain `created_at <` cursor would lose the boundary row here (the rows
    // share created_at, so `created_at < before` excludes every same-ms row
    // including the ones still to page). The compound `(created_at, id) <`
    // cursor + `ORDER BY created_at DESC, id DESC` keeps the order total so
    // every row lands on exactly one page. UUIDs are random, so id-DESC order
    // is NOT insertion order — we assert the no-drop property, not a fixed
    // identifier sequence.
    const sameMs = new Date('2026-07-09T10:00:00.000Z')
    await seedRun(id, { identifier: 'P1', createdAt: sameMs })
    await seedRun(id, { identifier: 'P2', createdAt: sameMs })
    await seedRun(id, { identifier: 'P3', createdAt: sameMs })

    // Page size 2 → first page returns 2 of the 3 same-ms rows.
    const first = (await (await app.request(`/api/v1/workspaces/${id}/threads?limit=2`, { method: 'GET' })).json()) as {
      data: { items: Array<{ id: string; identifier: string; createdAt: string }>; nextBefore: string; nextBeforeId: string }
    }
    expect(first.data.items).toHaveLength(2)
    expect(first.data.nextBefore).not.toBeNull()
    expect(first.data.nextBeforeId).not.toBeNull()

    // Walk the cursor: (before, beforeId) = the last item on page 1. The
    // cursor must be page 1's last row's (created_at, id) — the compound
    // comparison picks up strictly-older rows by id within the same ms.
    const last = first.data.items[first.data.items.length - 1]!
    expect(first.data.nextBefore).toBe(last.createdAt)
    expect(first.data.nextBeforeId).toBe(last.id)

    const second = (await (
      await app.request(
        `/api/v1/workspaces/${id}/threads?limit=2&before=${encodeURIComponent(first.data.nextBefore)}&beforeId=${last.id}`,
        { method: 'GET' },
      )
    ).json()) as { data: { items: Array<{ identifier: string }>; nextBefore: string | null; nextBeforeId: string | null } }
    // The one remaining same-ms row — it must NOT be dropped.
    expect(second.data.items).toHaveLength(1)
    expect(second.data.nextBefore).toBeNull()
    expect(second.data.nextBeforeId).toBeNull()

    // No row appeared on both pages, and all three surfaced across the two
    // pages — the no-drop guarantee the compound cursor exists for.
    const seen = new Set([...first.data.items.map((i) => i.identifier), ...second.data.items.map((i) => i.identifier)])
    expect(seen).toEqual(new Set(['P1', 'P2', 'P3']))
  })

  it('400s on beforeId without before', async () => {
    const id = await seedWorkspace({ name: 'Cursor Guard' })
    const res = await app.request(`/api/v1/workspaces/${id}/threads?beforeId=${randomUUID()}`, { method: 'GET' })
    expect(res.status).toBe(400)
  })

  it('returns an empty array (not 404) for a workspace with no runs', async () => {
    const id = await seedWorkspace({ name: 'Empty Thread' })
    const res = await app.request(`/api/v1/workspaces/${id}/threads`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { items: unknown[] } }
    expect(body.data.items).toEqual([])
  })

  it('400s on a malformed id', async () => {
    const res = await app.request('/api/v1/workspaces/not-a-uuid/threads', { method: 'GET' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/workspaces/:id/quota', () => {
  it('returns the normalized quota blob', async () => {
    const id = await seedWorkspace({
      name: 'Quota WS',
      quota: { runs: { used: 5, cap: 50 }, tokens: { used: 1000, cap: 10000 } },
    })
    const res = await app.request(`/api/v1/workspaces/${id}/quota`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { quota: { runs?: { used: number; cap: number }; tokens?: { used: number; cap: number } } } }
    expect(body.data.quota.runs?.used).toBe(5)
    expect(body.data.quota.tokens?.cap).toBe(10000)
  })

  it('404s when no workspace matches', async () => {
    const res = await app.request(`/api/v1/workspaces/${randomUUID()}/quota`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})

describe('workspace routes — error sanitization', () => {
  it('collapses a DB failure on the list path to a sanitized 502 (no stack leak)', async () => {
    // Drop the workspaces table mid-test so the list query throws, then
    // restore it so the rest of the suite (and afterEach cleanup) survives.
    await AppDataSource.query(`DROP TABLE IF EXISTS workspace_flows`)
    await AppDataSource.query(`DROP TABLE IF EXISTS workspace_members`)
    await AppDataSource.query(`DROP TABLE IF EXISTS workspaces`)
    try {
      const res = await app.request('/api/v1/workspaces', { method: 'GET' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toMatchObject({ success: false, error: 'workspace list failed' })
      // no pg stack / connection string leaks
      expect(JSON.stringify(body)).not.toMatch(/at /i)
      expect(JSON.stringify(body)).not.toContain('postgresql://')
    } finally {
      // Recreate the tables so cleanup + later suites don't blow up. The
      // migration's CREATE TABLE is idempotent against a missing table.
      await AppDataSource.query(`
        CREATE TABLE IF NOT EXISTS "workspaces" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "name" TEXT NOT NULL, "description" TEXT, "owner_user_id" TEXT,
          "status" TEXT NOT NULL DEFAULT 'active', "quota" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "glyph" TEXT, "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT workspaces_status_chk CHECK ("status" IN ('active','archived'))
        )`)
      await AppDataSource.query(`CREATE INDEX IF NOT EXISTS idx_workspaces_status ON "workspaces" ("status")`)
      await AppDataSource.query(`
        CREATE TABLE IF NOT EXISTS "workspace_members" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
          "member_id" TEXT NOT NULL, "display_name" TEXT, "initial" TEXT,
          "role" TEXT NOT NULL DEFAULT 'viewer', "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT workspace_members_role_chk CHECK ("role" IN ('owner','editor','viewer'))
        )`)
      await AppDataSource.query(`CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON "workspace_members" ("workspace_id")`)
      await AppDataSource.query(`CREATE INDEX IF NOT EXISTS idx_workspace_members_member ON "workspace_members" ("member_id")`)
      await AppDataSource.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_workspace_member ON "workspace_members" ("workspace_id", "member_id")`)
      await AppDataSource.query(`
        CREATE TABLE IF NOT EXISTS "workspace_flows" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
          "pipeline_id" TEXT NOT NULL, "note" TEXT, "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`)
      await AppDataSource.query(`CREATE INDEX IF NOT EXISTS idx_workspace_flows_workspace ON "workspace_flows" ("workspace_id")`)
      await AppDataSource.query(`CREATE INDEX IF NOT EXISTS idx_workspace_flows_pipeline ON "workspace_flows" ("pipeline_id")`)
      await AppDataSource.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_flows_workspace_pipeline ON "workspace_flows" ("workspace_id", "pipeline_id")`)
    }
  })
})
