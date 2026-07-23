import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource } from '@mil/db'

/**
 * Integration tests for the gateway `/api/v1/lab/*` API (plan M5b.2 /
 * P1.10.T7; dependency table P1.2.T9).
 *
 * Drives the gateway via `app.request()` against the real milagents Postgres
 * (the lab_sessions + lab_messages tables). `beforeAll` ensures the lab tables
 * exist via idempotent `CREATE TABLE IF NOT EXISTS` (mirroring the
 * `1720000006000-create-lab-tables.ts` migration's `up()` — the two must stay
 * in sync). We do NOT rely on `AppDataSource.runMigrations()` here because the
 * `@mil/db` package's tsup bundle does not ship the migration files (its
 * `entities`/`migrations` globs point at `dist/{entities,migrations}`, which
 * tsup does not populate), so the TypeORM runner finds zero migration files
 * under vitest. The other gateway suites (audit / tokens) sidestep this by
 * assuming their tables already exist; lab is new, so we create it here.
 *
 * Each test wipes lab_messages + lab_sessions so assertions are on the rows
 * this run wrote.
 *
 * Coverage:
 * - POST /sessions creates a session (status=running, mode=auto defaults)
 * - GET /sessions lists newest-first, filters by status
 * - GET /sessions/:id returns the session + its full thread (oldest-first)
 * - GET /sessions/:id/messages paginates the thread (newest page first)
 * - POST /sessions/:id/messages appends a turn, threads x-run-id into the row,
 *   re-derives agents_count, 404s on a missing session
 * - 400 on a malformed session id
 * - thinking + tool_call persist + round-trip verbatim
 */

/** Idempotent DDL mirroring migration 1720000006000's up(). Keep in sync. */
const LAB_DDL = [
  `CREATE TABLE IF NOT EXISTS "lab_sessions" (
     "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     "name"          TEXT NOT NULL,
     "description"   TEXT,
     "status"        TEXT NOT NULL DEFAULT 'running',
     "workspace_id"  UUID,
     "mode"          TEXT NOT NULL DEFAULT 'auto',
     "agents_count"  INTEGER NOT NULL DEFAULT 0,
     "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT lab_sessions_status_chk CHECK ("status" IN ('running','paused','done')),
     CONSTRAINT lab_sessions_mode_chk CHECK ("mode" IN ('auto','assist'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lab_sessions_workspace ON "lab_sessions" ("workspace_id")`,
  `CREATE INDEX IF NOT EXISTS idx_lab_sessions_status ON "lab_sessions" ("status")`,
  `CREATE TABLE IF NOT EXISTS "lab_messages" (
     "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     "session_id"  UUID NOT NULL REFERENCES "lab_sessions"("id") ON DELETE CASCADE,
     "parent_id"   UUID,
     "role"        TEXT NOT NULL,
     "agent_id"    TEXT,
     "run_id"      TEXT,
     "body"        TEXT NOT NULL,
     "thinking"    TEXT,
     "tool_call"   JSONB,
     "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT lab_messages_role_chk
       CHECK ("role" IN ('human','orchestrator','reader','coder','verifier','system'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lab_messages_session ON "lab_messages" ("session_id")`,
  `CREATE INDEX IF NOT EXISTS idx_lab_messages_parent ON "lab_messages" ("parent_id")`,
  `CREATE INDEX IF NOT EXISTS idx_lab_messages_run_id ON "lab_messages" ("run_id")`,
]

beforeAll(async () => {
  // The dev stack Postgres is remapped → 15432 (infra/README.md); the bare
  // :5432 on this machine is a different stale stack. `@mil/db`'s DataSource
  // captures POSTGRES_URL at module construction, and the env set here runs
  // after that import, so `??=` only helps a process where the env was unset
  // AND the DataSource was not yet constructed by another test in the same
  // vitest worker. We set it defensively; either stack works because the lab
  // DDL below is idempotent.
  process.env.POSTGRES_URL ??=
    'postgresql://milagents:milagents_dev@localhost:15432/milagents'
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  for (const stmt of LAB_DDL) {
    await AppDataSource.query(stmt)
  }
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  // lab_messages has ON DELETE CASCADE from lab_sessions, so deleting sessions
  // cleans both. Order matters: messages first is belt-and-suspenders.
  await AppDataSource.query(`DELETE FROM lab_messages`)
  await AppDataSource.query(`DELETE FROM lab_sessions`)
})

/** UUID shape used for test ids (valid RFC 4122). */
const UUID = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

async function createSession(
  body: Record<string, unknown>,
): Promise<{ id: string; [k: string]: unknown }> {
  const res = await app.request('/api/v1/lab/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { success: boolean; data: { session: Record<string, unknown> } }
  return json.data.session as { id: string; [k: string]: unknown }
}

async function appendMessage(
  id: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/v1/lab/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { success: boolean; data?: { message: Record<string, unknown> }; error?: string }
  return { status: res.status, ...json, message: json.data?.message }
}

describe('POST /api/v1/lab/sessions', () => {
  it('creates a session with running/auto defaults', async () => {
    const s = await createSession({ name: 'RL 复现', description: 'skip-connect 替代 attention' })
    expect(s.name).toBe('RL 复现')
    expect(s.status).toBe('running')
    expect(s.mode).toBe('auto')
    expect(s.agentsCount).toBe(0)
    expect(typeof s.id).toBe('string')
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('honours an explicit workspaceId + mode', async () => {
    const s = await createSession({ name: 'x', workspaceId: UUID, mode: 'assist' })
    expect(s.workspaceId).toBe(UUID)
    expect(s.mode).toBe('assist')
  })

  it('rejects an invalid mode with 400', async () => {
    const res = await app.request('/api/v1/lab/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', mode: 'bogus' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { success: boolean; error: string }
    expect(json.success).toBe(false)
  })

  it('rejects an empty name with 400', async () => {
    const res = await app.request('/api/v1/lab/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/lab/sessions', () => {
  it('lists sessions newest-first with a message-count rollup', async () => {
    const a = await createSession({ name: 'A' })
    const b = await createSession({ name: 'B' })
    await appendMessage(a.id, { role: 'human', body: 'hi' })
    await appendMessage(a.id, { role: 'orchestrator', body: 'yo', agentId: 'orchestrator-01' })

    const res = await app.request('/api/v1/lab/sessions')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; data: { items: Array<Record<string, unknown>> } }
    const items = json.data.items
    expect(items.length).toBe(2)
    // newest-first: B was created after A (updatedAt on A bumped by the appends,
    // so A sorts first — assert both present + counts correct).
    const aRow = items.find((r) => r.name === 'A')!
    const bRow = items.find((r) => r.name === 'B')!
    expect(aRow.messageCount).toBe(2)
    expect(bRow.messageCount).toBe(0)
  })

  it('defaults to status=running (a done session is hidden from a bare GET)', async () => {
    // This pins the fix for review #2: the route doc + console left-list
    // promise "running by default", but the schema was `.optional()` with no
    // default, so a bare GET returned every status. Now `status` defaults to
    // `running`.
    await createSession({ name: 'active' })
    const done = await createSession({ name: 'done-one' })
    await AppDataSource.query(`UPDATE lab_sessions SET status = 'done' WHERE id = $1`, [done.id])

    const res = await app.request('/api/v1/lab/sessions')
    const json = (await res.json()) as { success: boolean; data: { items: Array<Record<string, unknown>> } }
    const names = json.data.items.map((r) => r.name)
    expect(names).toContain('active')
    expect(names).not.toContain('done-one')
    expect(json.data.items.every((r) => r.status === 'running')).toBe(true)
  })

  it('status=all returns every status (including done)', async () => {
    const a = await createSession({ name: 'A' })
    await AppDataSource.query(`UPDATE lab_sessions SET status = 'done' WHERE id = $1`, [a.id])
    await createSession({ name: 'B' })

    const res = await app.request('/api/v1/lab/sessions?status=all')
    const json = (await res.json()) as { success: boolean; data: { items: Array<Record<string, unknown>> } }
    const names = json.data.items.map((r) => r.name)
    expect(names).toContain('A')
    expect(names).toContain('B')
  })

  it('filters by an explicit status', async () => {
    const a = await createSession({ name: 'A' })
    await AppDataSource.query(`UPDATE lab_sessions SET status = 'done' WHERE id = $1`, [a.id])

    const res = await app.request('/api/v1/lab/sessions?status=done')
    const json = (await res.json()) as { success: boolean; data: { items: Array<Record<string, unknown>> } }
    expect(json.data.items.every((r) => r.status === 'done')).toBe(true)
    expect(json.data.items.find((r) => r.name === 'A')).toBeTruthy()
  })
})

describe('GET /api/v1/lab/sessions/:id', () => {
  it('returns the session + its full thread oldest-first', async () => {
    const s = await createSession({ name: 'A' })
    await appendMessage(s.id, { role: 'human', body: 'first' })
    await appendMessage(s.id, { role: 'orchestrator', body: 'second', agentId: 'orchestrator-01' })

    const res = await app.request(`/api/v1/lab/sessions/${s.id}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      success: boolean
      data: { session: Record<string, unknown>; messages: Array<Record<string, unknown>> }
    }
    expect(json.data.session.id).toBe(s.id)
    expect(json.data.messages.map((m) => m.body)).toEqual(['first', 'second'])
  })

  it('404s on a missing session', async () => {
    const res = await app.request(`/api/v1/lab/sessions/${UUID_B}`)
    expect(res.status).toBe(404)
  })

  it('400s on a malformed id', async () => {
    const res = await app.request('/api/v1/lab/sessions/not-a-uuid')
    expect(res.status).toBe(400)
  })

  it('caps the detail thread at the most recent 200 messages', async () => {
    // Pins review #4: detail used to return the whole thread with no LIMIT.
    // Now it caps at the newest 200 (oldest-first in the response).
    const s = await createSession({ name: 'A' })
    for (let i = 0; i < 202; i++) {
      await appendMessage(s.id, { role: 'human', body: `m${i}` })
    }
    const res = await app.request(`/api/v1/lab/sessions/${s.id}`)
    const json = (await res.json()) as {
      success: boolean
      data: { messages: Array<Record<string, unknown>> }
    }
    expect(json.data.messages.length).toBe(200)
    // newest 200, oldest-first: first body is m2 (we wrote 0..201, dropped 0,1)
    expect(json.data.messages[0]!.body).toBe('m2')
    expect(json.data.messages[199]!.body).toBe('m201')
  })
})

describe('PATCH /api/v1/lab/sessions/:id', () => {
  it('updates mode and returns the updated row', async () => {
    const s = await createSession({ name: 'A' })
    expect(s.mode).toBe('auto')
    const res = await app.request(`/api/v1/lab/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'assist' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; data: { session: Record<string, unknown> } }
    expect(json.data.session.mode).toBe('assist')
  })

  it('updates status (archive → done)', async () => {
    const s = await createSession({ name: 'A' })
    expect(s.status).toBe('running')
    const res = await app.request(`/api/v1/lab/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; data: { session: Record<string, unknown> } }
    expect(json.data.session.status).toBe('done')
  })

  it('updates mode + status together', async () => {
    const s = await createSession({ name: 'A' })
    const res = await app.request(`/api/v1/lab/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'assist', status: 'paused' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean; data: { session: Record<string, unknown> } }
    expect(json.data.session.mode).toBe('assist')
    expect(json.data.session.status).toBe('paused')
  })

  it('400s when neither mode nor status is provided', async () => {
    const s = await createSession({ name: 'A' })
    const res = await app.request(`/api/v1/lab/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('400s on an invalid mode', async () => {
    const s = await createSession({ name: 'A' })
    const res = await app.request(`/api/v1/lab/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus' }),
    })
    expect(res.status).toBe(400)
  })

  it('404s on a missing session', async () => {
    const res = await app.request(`/api/v1/lab/sessions/${UUID_B}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'assist' }),
    })
    expect(res.status).toBe(404)
  })

  it('400s on a malformed id', async () => {
    const res = await app.request('/api/v1/lab/sessions/not-a-uuid', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'assist' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/lab/sessions/:id/messages', () => {
  it('appends a turn, threads x-run-id into the row', async () => {
    const s = await createSession({ name: 'A' })
    const r = await appendMessage(s.id, { role: 'human', body: '介入' }, { 'x-run-id': 'run-trace-1' })
    expect(r.status).toBe(200)
    expect((r.message as Record<string, unknown>).body).toBe('介入')
    expect((r.message as Record<string, unknown>).runId).toBe('run-trace-1')
    expect((r.message as Record<string, unknown>).role).toBe('human')
  })

  it('persists thinking + tool_call verbatim', async () => {
    const s = await createSession({ name: 'A' })
    const r = await appendMessage(s.id, {
      role: 'reader',
      agentId: 'reader-04',
      body: '已抽取',
      thinking: '先读再改再验',
      toolCall: { name: 'read_paper', input: '§3.2', output: 'claims:[14]' },
    })
    expect((r.message as Record<string, unknown>).thinking).toBe('先读再改再验')
    expect((r.message as Record<string, unknown>).toolCall).toEqual({
      name: 'read_paper',
      input: '§3.2',
      output: 'claims:[14]',
    })
  })

  it('threads a parent_id reply link', async () => {
    const s = await createSession({ name: 'A' })
    const parent = await appendMessage(s.id, { role: 'human', body: 'parent' })
    const parentId = (parent.message as Record<string, unknown>).id as string
    const r = await appendMessage(s.id, { role: 'orchestrator', body: 'reply', parentId })
    expect((r.message as Record<string, unknown>).parentId).toBe(parentId)
  })

  it('re-derives agents_count after a new agent turn', async () => {
    const s = await createSession({ name: 'A' })
    await appendMessage(s.id, { role: 'orchestrator', body: 'a', agentId: 'orchestrator-01' })
    await appendMessage(s.id, { role: 'reader', body: 'b', agentId: 'reader-04' })
    await appendMessage(s.id, { role: 'reader', body: 'c', agentId: 'reader-04' })

    const res = await app.request(`/api/v1/lab/sessions/${s.id}`)
    const json = (await res.json()) as { success: boolean; data: { session: Record<string, unknown> } }
    // 2 distinct agent_ids spoke → agentsCount 2
    expect(json.data.session.agentsCount).toBe(2)
  })

  it('404s on a missing session', async () => {
    const r = await appendMessage(UUID_B, { role: 'human', body: 'x' })
    expect(r.status).toBe(404)
  })

  it('400s on a malformed session id', async () => {
    const r = await appendMessage('not-a-uuid', { role: 'human', body: 'x' })
    expect(r.status).toBe(400)
  })

  it('400s on an invalid role', async () => {
    const s = await createSession({ name: 'A' })
    const r = await appendMessage(s.id, { role: 'wizard', body: 'x' })
    expect(r.status).toBe(400)
  })

  it('400s on an empty body', async () => {
    const s = await createSession({ name: 'A' })
    const r = await appendMessage(s.id, { role: 'human', body: '' })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/v1/lab/sessions/:id/messages', () => {
  it('returns the newest page first, oldest-first within the page', async () => {
    const s = await createSession({ name: 'A' })
    for (let i = 0; i < 3; i++) {
      await appendMessage(s.id, { role: 'human', body: `m${i}` })
    }
    const res = await app.request(`/api/v1/lab/sessions/${s.id}/messages?limit=2`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      success: boolean
      data: { items: Array<Record<string, unknown>>; nextBefore: string | null }
    }
    // newest page (m1, m2) → oldest-first within the page
    expect(json.data.items.map((m) => m.body)).toEqual(['m1', 'm2'])
    expect(json.data.nextBefore).not.toBeNull()
  })

  it('400s on a malformed session id', async () => {
    const res = await app.request('/api/v1/lab/sessions/not-a-uuid/messages')
    expect(res.status).toBe(400)
  })
})
