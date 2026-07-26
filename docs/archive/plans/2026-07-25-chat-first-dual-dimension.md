# Chat-First 双维度模型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy workspace + chat split with a chat-first dual-dimension model: directories (project folders) → chats (conversations). Add chat home page, conversation detail, and directory management UI.

**Architecture:** Three-phase rollout — (1) data layer: new tables + entities + migration from workspaces, (2) backend API: directory + chat CRUD routes on gateway + Next.js proxy routes, (3) frontend: chat home, conversation detail, directory management pages with OpenWebUI-style layout. Existing workspaces API stays as a read-only compatibility shim until phase 3 is done.

**Tech Stack:** TypeScript, TypeORM (entities only, raw SQL at runtime), Hono (gateway), Next.js 15 App Router (console), Vitest, Zod, PostgreSQL

---

## Phase 1: Data Layer — New Tables + Entities + Migration

### Task 1.1: Create directories / chats / chat_messages tables migration

**Files:**
- Create: `packages/db/src/migrations/1720000009000-create-chat-tables.ts`
- Test: `pnpm --filter @dagents/db typeorm migration:run`

- [ ] **Step 1: Write the migration file**

Create `packages/db/src/migrations/1720000009000-create-chat-tables.ts`:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm'

export class CreateChatTables1720000009000 implements MigrationInterface {
  name = 'CreateChatTables1720000009000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "directories" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "path"       TEXT NOT NULL,
        "name"       TEXT NOT NULL,
        "settings"   JSONB NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await qr.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_directories_path ON "directories" ("path")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_directories_name ON "directories" ("name")`,
    )

    await qr.query(`
      CREATE TABLE IF NOT EXISTS "chats" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "directory_id"   UUID NOT NULL REFERENCES "directories"("id") ON DELETE CASCADE,
        "title"          TEXT NOT NULL,
        "status"         TEXT NOT NULL DEFAULT 'idle',
        "agent_id"       UUID,
        "flow_id"        TEXT,
        "last_message"   TEXT,
        "message_count"  INTEGER NOT NULL DEFAULT 0,
        "last_run_id"    UUID,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chats_status_chk CHECK ("status" IN ('idle','running','done','failed'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chats_directory ON "chats" ("directory_id", "updated_at" DESC)`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chats_status ON "chats" ("status")`,
    )

    await qr.query(`
      CREATE TABLE IF NOT EXISTS "chat_messages" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "chat_id"    UUID NOT NULL REFERENCES "chats"("id") ON DELETE CASCADE,
        "role"       TEXT NOT NULL,
        "content"    TEXT NOT NULL,
        "run_id"     UUID,
        "metadata"   JSONB NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chat_messages_role_chk CHECK ("role" IN ('user','assistant','system','tool'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON "chat_messages" ("chat_id", "created_at")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_run ON "chat_messages" ("run_id")`,
    )

    await qr.query(
      `ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "chat_id" TEXT`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_chat_status ON "runs" ("chat_id", "status")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_runs_chat_status`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "chat_id"`)
    await qr.query(`DROP INDEX IF EXISTS idx_chat_messages_run`)
    await qr.query(`DROP INDEX IF EXISTS idx_chat_messages_chat`)
    await qr.query(`DROP TABLE IF EXISTS "chat_messages"`)
    await qr.query(`DROP INDEX IF EXISTS idx_chats_status`)
    await qr.query(`DROP INDEX IF EXISTS idx_chats_directory`)
    await qr.query(`DROP TABLE IF EXISTS "chats"`)
    await qr.query(`DROP INDEX IF EXISTS idx_directories_name`)
    await qr.query(`DROP INDEX IF EXISTS idx_directories_path`)
    await qr.query(`DROP TABLE IF EXISTS "directories"`)
  }
}
```

- [ ] **Step 2: Verify migration runs forward**

Run:
```bash
cd /Users/rowan/Projects/dagents-main
pnpm --filter @dagents/db typeorm migration:run -d src/data-source.ts
```
Expected: migration `CreateChatTables1720000009000` has been executed successfully.

- [ ] **Step 3: Verify migration rolls back**

Run:
```bash
pnpm --filter @dagents/db typeorm migration:revert -d src/data-source.ts
```
Expected: migration `CreateChatTables1720000009000` has been reverted successfully.

- [ ] **Step 4: Re-run migration forward**

Run:
```bash
pnpm --filter @dagents/db typeorm migration:run -d src/data-source.ts
```
Expected: migration applied successfully.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/1720000009000-create-chat-tables.ts
git commit -m "feat(db): add directories/chats/chat_messages tables + runs.chat_id"
```

---

### Task 1.2: Create workspaces → directories data migration

**Files:**
- Create: `packages/db/src/migrations/1720000009001-migrate-workspaces-to-directories.ts`

- [ ] **Step 1: Write the data migration file**

Create `packages/db/src/migrations/1720000009001-migrate-workspaces-to-directories.ts`:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm'

export class MigrateWorkspacesToDirectories1720000009001 implements MigrationInterface {
  name = 'MigrateWorkspacesToDirectories1720000009001'

  async up(qr: QueryRunner): Promise<void> {
    const wsCheck = await qr.query(
      `SELECT to_regclass('workspaces') IS NOT NULL AS exists`,
    )
    if (!wsCheck[0]?.exists) return

    await qr.query(`
      INSERT INTO "directories" (id, path, name, settings, created_at, updated_at)
      SELECT
        w.id,
        COALESCE(w.name, w.id::text),
        w.name,
        jsonb_build_object(
          'quota', w.quota,
          'description', w.description,
          'glyph', w.glyph,
          'ownerUserId', w.owner_user_id
        ),
        w.created_at,
        w.updated_at
      FROM "workspaces" w
      WHERE w.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM "directories" d WHERE d.id = w.id)
      ON CONFLICT (id) DO NOTHING
    `)

    const runCheck = await qr.query(
      `SELECT to_regclass('runs') IS NOT NULL AS exists`,
    )
    if (!runCheck[0]?.exists) return

    await qr.query(`
      INSERT INTO "chats" (id, directory_id, title, status, last_run_id, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        r.workspace_id::uuid,
        'Migrated from workspace run',
        CASE
          WHEN r.status IN ('completed') THEN 'done'
          WHEN r.status IN ('failed','cancelled') THEN 'failed'
          WHEN r.status IN ('running','pending') THEN 'running'
          ELSE 'idle'
        END,
        r.id,
        r.created_at,
        COALESCE(r.finished_at, r.updated_at, NOW())
      FROM "runs" r
      WHERE r.workspace_id IS NOT NULL
        AND r.workspace_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND r.workspace_id::uuid IN (SELECT id FROM "directories")
        AND r.parent_run_id IS NULL
    `)

    await qr.query(`
      UPDATE "runs" r
      SET "chat_id" = c.id
      FROM "chats" c
      WHERE r.workspace_id IS NOT NULL
        AND r.workspace_id = c.directory_id::text
        AND r.id = c.last_run_id::text
        AND r.parent_run_id IS NULL
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`UPDATE "runs" SET "chat_id" = NULL WHERE "chat_id" IS NOT NULL`)
    await qr.query(`DELETE FROM "chat_messages"`)
    await qr.query(`DELETE FROM "chats"`)
    await qr.query(`DELETE FROM "directories"`)
  }
}
```

- [ ] **Step 2: Run the migration**

Run:
```bash
pnpm --filter @dagents/db typeorm migration:run -d src/data-source.ts
```
Expected: migration `MigrateWorkspacesToDirectories1720000009001` applied successfully.

- [ ] **Step 3: Verify data was migrated**

Run:
```bash
psql -U dagents -h localhost -p 15432 -d dagents -c "SELECT count(*) FROM directories; SELECT count(*) FROM chats;"
```
Expected: directories count equals active workspaces count; chats count equals number of top-level runs with valid workspace_id.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/migrations/1720000009001-migrate-workspaces-to-directories.ts
git commit -m "feat(db): migrate workspaces data to directories and create chats from runs"
```

---

### Task 1.3: Create Directory, Chat, ChatMessage entities

**Files:**
- Create: `packages/db/src/entities/directory.entity.ts`
- Create: `packages/db/src/entities/chat.entity.ts`
- Create: `packages/db/src/entities/chat-message.entity.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Create Directory entity**

Create `packages/db/src/entities/directory.entity.ts`:

```ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity({ name: 'directories' })
export class Directory {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'text', unique: true })
  path!: string

  @Column({ type: 'text' })
  name!: string

  @Column({ type: 'jsonb', default: {} })
  settings!: Record<string, unknown>

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
```

- [ ] **Step 2: Create Chat entity**

Create `packages/db/src/entities/chat.entity.ts`:

```ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

export type ChatStatus = 'idle' | 'running' | 'done' | 'failed'

@Entity({ name: 'chats' })
@Index('idx_chats_directory', ['directoryId', 'updatedAt'])
@Index('idx_chats_status', ['status'])
export class Chat {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'directory_id', type: 'uuid' })
  directoryId!: string

  @Column({ type: 'text' })
  title!: string

  @Column({ type: 'text', default: 'idle' })
  status!: ChatStatus

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId!: string | null

  @Column({ name: 'flow_id', type: 'text', nullable: true })
  flowId!: string | null

  @Column({ name: 'last_message', type: 'text', nullable: true })
  lastMessage!: string | null

  @Column({ name: 'message_count', type: 'int', default: 0 })
  messageCount!: number

  @Column({ name: 'last_run_id', type: 'uuid', nullable: true })
  lastRunId!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
```

- [ ] **Step 3: Create ChatMessage entity**

Create `packages/db/src/entities/chat-message.entity.ts`:

```ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'

@Entity({ name: 'chat_messages' })
@Index('idx_chat_messages_chat', ['chatId', 'createdAt'])
@Index('idx_chat_messages_run', ['runId'])
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ name: 'chat_id', type: 'uuid' })
  chatId!: string

  @Column({ type: 'text' })
  role!: ChatMessageRole

  @Column({ type: 'text' })
  content!: string

  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId!: string | null

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
```

- [ ] **Step 4: Export entities from db package index**

Read `packages/db/src/index.ts` and add the new exports at the end of the file, following the existing pattern:

```ts
export { Directory } from './entities/directory.entity.js'
export { Chat } from './entities/chat.entity.js'
export type { ChatStatus } from './entities/chat.entity.js'
export { ChatMessage } from './entities/chat-message.entity.js'
export type { ChatMessageRole } from './entities/chat-message.entity.js'
```

- [ ] **Step 5: Verify TypeScript compiles**

Run:
```bash
pnpm --filter @dagents/db build
```
Expected: build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/entities/directory.entity.ts \
        packages/db/src/entities/chat.entity.ts \
        packages/db/src/entities/chat-message.entity.ts \
        packages/db/src/index.ts
git commit -m "feat(db): add Directory, Chat, ChatMessage entities"
```

---

## Phase 2: Backend API — Directories + Chats CRUD

### Task 2.1: Create gateway directory routes

**Files:**
- Create: `apps/gateway/src/routes/directories.ts`
- Modify: `apps/gateway/src/app.ts`

- [ ] **Step 1: Write failing test for directories list endpoint**

Create `apps/gateway/src/__tests__/directories.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

let seededDirIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  for (const id of seededDirIds) {
    await runQuery(`DELETE FROM "directories" WHERE id = $1`, [id])
  }
  seededDirIds = []
})

async function seedDirectory(opts: { path: string; name: string }): Promise<string> {
  const id = randomUUID()
  await runQuery(
    `INSERT INTO "directories" (id, path, name) VALUES ($1, $2, $3)`,
    [id, opts.path, opts.name],
  )
  seededDirIds.push(id)
  return id
}

describe('GET /api/v1/directories — list', () => {
  it('returns directories sorted by updated_at desc', async () => {
    await seedDirectory({ path: '/tmp/a', name: 'Project A' })
    await new Promise((r) => setTimeout(r, 10))
    await seedDirectory({ path: '/tmp/b', name: 'Project B' })

    const res = await app.request('/api/v1/directories', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)
    expect(body.data.items.length).toBeGreaterThanOrEqual(2)
    const names = body.data.items.map((d: { name: string }) => d.name)
    expect(names.indexOf('Project B')).toBeLessThan(names.indexOf('Project A'))
  })

  it('respects limit query param', async () => {
    await seedDirectory({ path: '/tmp/1', name: 'P1' })
    await seedDirectory({ path: '/tmp/2', name: 'P2' })
    await seedDirectory({ path: '/tmp/3', name: 'P3' })

    const res = await app.request('/api/v1/directories?limit=2', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.items.length).toBe(2)
  })
})

describe('GET /api/v1/directories/:id — detail', () => {
  it('returns directory with chat count and settings', async () => {
    const id = await seedDirectory({ path: '/tmp/d1', name: 'Detail Proj' })

    const res = await app.request(`/api/v1/directories/${id}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.directory.id).toBe(id)
    expect(body.data.directory.name).toBe('Detail Proj')
    expect(body.data.directory.path).toBe('/tmp/d1')
  })

  it('returns 404 for missing id', async () => {
    const fakeId = randomUUID()
    const res = await app.request(`/api/v1/directories/${fakeId}`, { method: 'GET' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('directory not found')
  })

  it('returns 400 for malformed id', async () => {
    const res = await app.request('/api/v1/directories/not-a-uuid', { method: 'GET' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/directories — create', () => {
  it('creates a directory with path and name', async () => {
    const path = `/tmp/test-create-${randomUUID()}`
    const res = await app.request('/api/v1/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name: 'New Project' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.directory.path).toBe(path)
    expect(body.data.directory.name).toBe('New Project')
    seededDirIds.push(body.data.directory.id)
  })

  it('returns 400 when path is missing', async () => {
    const res = await app.request('/api/v1/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Path' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/v1/directories/:id — update', () => {
  it('updates directory name and settings', async () => {
    const id = await seedDirectory({ path: '/tmp/upd', name: 'Old Name' })

    const res = await app.request(`/api/v1/directories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.directory.name).toBe('New Name')
  })
})

describe('DELETE /api/v1/directories/:id — delete', () => {
  it('deletes a directory', async () => {
    const id = await seedDirectory({ path: '/tmp/del', name: 'To Delete' })

    const res = await app.request(`/api/v1/directories/${id}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    const check = await app.request(`/api/v1/directories/${id}`, { method: 'GET' })
    expect(check.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @dagents/gateway test -- directories.test.ts
```
Expected: tests fail with 404 or route not found errors.

- [ ] **Step 3: Implement directory routes**

Create `apps/gateway/src/routes/directories.ts`:

```ts
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

export const directoryRoutes = new Hono()

const log = createLogger({ svc: 'gateway:directories' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  withChats: z.enum(['true', 'false']).optional(),
})

const createBodySchema = z.object({
  path: z.string().min(1).max(2048),
  name: z.string().min(1).max(255).optional(),
  settings: z.record(z.unknown()).optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  settings: z.record(z.unknown()).optional(),
})

interface DirRow {
  id: string
  path: string
  name: string
  settings: unknown
  created_at: Date
  updated_at: Date
  chat_count?: string | null
}

function normalizeDir(r: DirRow) {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    settings: typeof r.settings === 'object' && r.settings !== null ? r.settings : {},
    chatCount: Number(r.chat_count ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

directoryRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  }
  const q = parsed.data

  try {
    const { records } = await runQuery<DirRow>(
      `SELECT d.id, d.path, d.name, d.settings, d.created_at, d.updated_at,
              (SELECT count(*)::text FROM chats WHERE directory_id = d.id) AS chat_count
         FROM directories d
         ORDER BY d.updated_at DESC
         LIMIT $1`,
      [q.limit],
    )
    return ok(c, {
      items: records.map(normalizeDir),
    })
  } catch (err) {
    log.error('directory list failed', { error: String(err) })
    return fail(c, 502, 'directory list failed')
  }
})

directoryRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid directory id', { id })

  try {
    const { records } = await runQuery<DirRow>(
      `SELECT d.id, d.path, d.name, d.settings, d.created_at, d.updated_at,
              (SELECT count(*)::text FROM chats WHERE directory_id = d.id) AS chat_count
         FROM directories d WHERE d.id = $1`,
      [id],
    )
    const row = records[0]
    if (!row) return fail(c, 404, 'directory not found', { id })
    return ok(c, { directory: normalizeDir(row) })
  } catch (err) {
    log.error('directory detail failed', { id, error: String(err) })
    return fail(c, 502, 'directory detail failed')
  }
})

directoryRoutes.post('/', async (c) => {
  let parsed: z.infer<typeof createBodySchema>
  try {
    parsed = createBodySchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  const name = parsed.name ?? parsed.path.split('/').filter(Boolean).pop() ?? parsed.path

  try {
    const { records } = await runQuery<DirRow>(
      `INSERT INTO "directories" (path, name, settings)
       VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb))
       RETURNING id, path, name, settings, created_at, updated_at`,
      [parsed.path, name, parsed.settings ?? null],
    )
    return ok(c, { directory: normalizeDir(records[0]!) })
  } catch (err) {
    log.error('directory create failed', { path: parsed.path, error: String(err) })
    return fail(c, 502, 'directory create failed')
  }
})

directoryRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid directory id', { id })

  let parsed: z.infer<typeof updateBodySchema>
  try {
    parsed = updateBodySchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  const sets: string[] = []
  const params: unknown[] = []
  if (parsed.name !== undefined) {
    params.push(parsed.name)
    sets.push(`name = $${params.length}`)
  }
  if (parsed.settings !== undefined) {
    params.push(parsed.settings)
    sets.push(`settings = $${params.length}::jsonb`)
  }
  if (sets.length === 0) {
    return fail(c, 400, 'nothing to update')
  }
  params.push(id)
  sets.push(`updated_at = NOW()`)

  try {
    const { records } = await runQuery<DirRow>(
      `UPDATE "directories" SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, path, name, settings, created_at, updated_at`,
      params,
    )
    const row = records[0]
    if (!row) return fail(c, 404, 'directory not found', { id })
    return ok(c, { directory: normalizeDir(row) })
  } catch (err) {
    log.error('directory update failed', { id, error: String(err) })
    return fail(c, 502, 'directory update failed')
  }
})

directoryRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid directory id', { id })

  try {
    const { affected } = await runQuery(
      `DELETE FROM "directories" WHERE id = $1`,
      [id],
    )
    if (affected === 0) return fail(c, 404, 'directory not found', { id })
    return ok(c, { deleted: true, id })
  } catch (err) {
    log.error('directory delete failed', { id, error: String(err) })
    return fail(c, 502, 'directory delete failed')
  }
})
```

- [ ] **Step 4: Mount routes in gateway app.ts**

In `apps/gateway/src/app.ts`, add the import:
```ts
import { directoryRoutes } from './routes/directories.js'
```

And mount it after the workspace routes (around line 486):
```ts
app.route('/api/v1/directories', directoryRoutes)
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm --filter @dagents/gateway test -- directories.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/routes/directories.ts \
        apps/gateway/src/__tests__/directories.test.ts \
        apps/gateway/src/app.ts
git commit -m "feat(gateway): add directories CRUD API"
```

---

### Task 2.2: Create gateway chat routes (CRUD + messages list)

**Files:**
- Create: `apps/gateway/src/routes/chats.ts`
- Modify: `apps/gateway/src/app.ts`

- [ ] **Step 1: Write failing test for chat endpoints**

Create `apps/gateway/src/__tests__/chats.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

let seededIds: { dirId: string; chatIds: string[] }[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  for (const { dirId } of seededIds) {
    await runQuery(`DELETE FROM "directories" WHERE id = $1`, [dirId])
  }
  seededIds = []
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

beforeEach(async () => {
  for (const { dirId } of seededIds) {
    await runQuery(`DELETE FROM "chat_messages" WHERE chat_id IN (SELECT id FROM chats WHERE directory_id = $1)`, [dirId])
    await runQuery(`DELETE FROM "chats" WHERE directory_id = $1`, [dirId])
    await runQuery(`DELETE FROM "directories" WHERE id = $1`, [dirId])
  }
  seededIds = []
})

async function seedDirAndChat(opts: { dirPath: string; chatTitle: string }): Promise<{ dirId: string; chatId: string }> {
  const dirId = randomUUID()
  const chatId = randomUUID()
  await runQuery(
    `INSERT INTO "directories" (id, path, name) VALUES ($1, $2, $3)`,
    [dirId, opts.dirPath, opts.dirPath.split('/').pop()!],
  )
  await runQuery(
    `INSERT INTO "chats" (id, directory_id, title) VALUES ($1, $2, $3)`,
    [chatId, dirId, opts.chatTitle],
  )
  seededIds.push({ dirId, chatIds: [chatId] })
  return { dirId, chatId }
}

describe('GET /api/v1/chats — list', () => {
  it('lists chats filtered by directory_id', async () => {
    const { dirId } = await seedDirAndChat({ dirPath: '/tmp/list1', chatTitle: 'Chat 1' })

    const res = await app.request(`/api/v1/chats?directory_id=${dirId}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)
    expect(body.data.items.length).toBeGreaterThanOrEqual(1)
    expect(body.data.items[0].title).toBe('Chat 1')
  })

  it('returns all chats when no filter', async () => {
    await seedDirAndChat({ dirPath: '/tmp/list2', chatTitle: 'All Chat' })

    const res = await app.request('/api/v1/chats', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.items)).toBe(true)
  })
})

describe('POST /api/v1/chats — create', () => {
  it('creates a chat with directory_id and title', async () => {
    const dirId = randomUUID()
    await runQuery(
      `INSERT INTO "directories" (id, path, name) VALUES ($1, $2, $3)`,
      [dirId, '/tmp/create-dir', 'Create Dir'],
    )
    seededIds.push({ dirId, chatIds: [] })

    const res = await app.request('/api/v1/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directoryId: dirId, title: 'New Chat' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.chat.title).toBe('New Chat')
    expect(body.data.chat.directoryId).toBe(dirId)
  })

  it('returns 400 when directory_id is missing', async () => {
    const res = await app.request('/api/v1/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No Dir' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/chats/:id — detail', () => {
  it('returns chat detail', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/detail', chatTitle: 'Detail Chat' })

    const res = await app.request(`/api/v1/chats/${chatId}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.chat.id).toBe(chatId)
    expect(body.data.chat.title).toBe('Detail Chat')
  })

  it('returns 404 for missing chat', async () => {
    const fakeId = randomUUID()
    const res = await app.request(`/api/v1/chats/${fakeId}`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/v1/chats/:id — update', () => {
  it('updates chat title', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/upd', chatTitle: 'Old' })

    const res = await app.request(`/api/v1/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.chat.title).toBe('New Title')
  })
})

describe('DELETE /api/v1/chats/:id — delete', () => {
  it('deletes a chat', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/del', chatTitle: 'To Delete' })

    const res = await app.request(`/api/v1/chats/${chatId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const check = await app.request(`/api/v1/chats/${chatId}`, { method: 'GET' })
    expect(check.status).toBe(404)
  })
})

describe('POST /api/v1/chats/:id/messages — send message', () => {
  it('creates a user message and updates chat counters', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/msgsend', chatTitle: 'Send Chat' })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello world' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.content).toBe('Hello world')
    expect(body.data.message.chatId).toBe(chatId)

    const chatRes = await app.request(`/api/v1/chats/${chatId}`, { method: 'GET' })
    const chatBody = await chatRes.json()
    expect(chatBody.data.chat.messageCount).toBe(1)
    expect(chatBody.data.chat.lastMessage).toBe('Hello world')
  })

  it('returns 400 when content is empty', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/msgempty', chatTitle: 'Empty Chat' })
    const res = await app.request(`/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for non-existent chat', async () => {
    const fakeId = randomUUID()
    const res = await app.request(`/api/v1/chats/${fakeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/chats/:id/messages — list messages', () => {
  it('returns empty array for new chat', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/msglist', chatTitle: 'Msg Chat' })

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.items).toEqual([])
  })

  it('returns messages ordered by created_at', async () => {
    const { chatId } = await seedDirAndChat({ dirPath: '/tmp/msgorder', chatTitle: 'Order Chat' })
    await runQuery(
      `INSERT INTO "chat_messages" (chat_id, role, content) VALUES ($1, 'user', 'hello')`,
      [chatId],
    )
    await runQuery(
      `INSERT INTO "chat_messages" (chat_id, role, content) VALUES ($1, 'assistant', 'hi there')`,
      [chatId],
    )

    const res = await app.request(`/api/v1/chats/${chatId}/messages`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.items.length).toBe(2)
    expect(body.data.items[0].role).toBe('user')
    expect(body.data.items[1].role).toBe('assistant')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @dagents/gateway test -- chats.test.ts
```
Expected: tests fail with 404 errors.

- [ ] **Step 3: Implement chat routes**

Create `apps/gateway/src/routes/chats.ts`:

```ts
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

export const chatRoutes = new Hono()

const log = createLogger({ svc: 'gateway:chats' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
  directoryId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.string().optional(),
})

const createBodySchema = z.object({
  directoryId: z.string().uuid(),
  title: z.string().min(1).max(255).optional(),
  agentId: z.string().uuid().optional(),
  flowId: z.string().min(1).max(255).optional(),
})

const updateBodySchema = z.object({
  title: z.string().min(1).max(255).optional(),
  status: z.enum(['idle', 'running', 'done', 'failed']).optional(),
  agentId: z.string().uuid().nullable().optional(),
  flowId: z.string().min(1).max(255).nullable().optional(),
})

const msgListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().datetime().optional(),
  beforeId: z.string().uuid().optional(),
})

interface ChatRow {
  id: string
  directory_id: string
  title: string
  status: string
  agent_id: string | null
  flow_id: string | null
  last_message: string | null
  message_count: number
  last_run_id: string | null
  created_at: Date
  updated_at: Date
}

interface MsgRow {
  id: string
  chat_id: string
  role: string
  content: string
  run_id: string | null
  metadata: unknown
  created_at: Date
}

function normalizeChat(r: ChatRow) {
  return {
    id: r.id,
    directoryId: r.directory_id,
    title: r.title,
    status: r.status,
    agentId: r.agent_id,
    flowId: r.flow_id,
    lastMessage: r.last_message,
    messageCount: r.message_count,
    lastRunId: r.last_run_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

function normalizeMsg(r: MsgRow) {
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    metadata: typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {},
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  }
}

chatRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  const q = parsed.data

  const params: unknown[] = []
  const clauses: string[] = ['1=1']
  if (q.directoryId) {
    params.push(q.directoryId)
    clauses.push(`directory_id = $${params.length}`)
  }
  if (q.status) {
    params.push(q.status)
    clauses.push(`status = $${params.length}`)
  }
  params.push(q.limit)

  try {
    const { records } = await runQuery<ChatRow>(
      `SELECT id, directory_id, title, status, agent_id, flow_id, last_message,
              message_count, last_run_id, created_at, updated_at
         FROM chats
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT $${params.length}`,
      params,
    )
    return ok(c, { items: records.map(normalizeChat) })
  } catch (err) {
    log.error('chat list failed', { error: String(err) })
    return fail(c, 502, 'chat list failed')
  }
})

chatRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid chat id', { id })

  try {
    const { records } = await runQuery<ChatRow>(
      `SELECT id, directory_id, title, status, agent_id, flow_id, last_message,
              message_count, last_run_id, created_at, updated_at
         FROM chats WHERE id = $1`,
      [id],
    )
    const row = records[0]
    if (!row) return fail(c, 404, 'chat not found', { id })
    return ok(c, { chat: normalizeChat(row) })
  } catch (err) {
    log.error('chat detail failed', { id, error: String(err) })
    return fail(c, 502, 'chat detail failed')
  }
})

chatRoutes.post('/', async (c) => {
  let parsed: z.infer<typeof createBodySchema>
  try {
    parsed = createBodySchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  const title = parsed.title ?? 'New Chat'

  try {
    const dirCheck = await runQuery(`SELECT id FROM directories WHERE id = $1`, [parsed.directoryId])
    if (dirCheck.records.length === 0) {
      return fail(c, 404, 'directory not found', { directoryId: parsed.directoryId })
    }

    const { records } = await runQuery<ChatRow>(
      `INSERT INTO "chats" (directory_id, title, agent_id, flow_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, directory_id, title, status, agent_id, flow_id, last_message,
                 message_count, last_run_id, created_at, updated_at`,
      [parsed.directoryId, title, parsed.agentId ?? null, parsed.flowId ?? null],
    )
    return ok(c, { chat: normalizeChat(records[0]!) })
  } catch (err) {
    log.error('chat create failed', { error: String(err) })
    return fail(c, 502, 'chat create failed')
  }
})

chatRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid chat id', { id })

  let parsed: z.infer<typeof updateBodySchema>
  try {
    parsed = updateBodySchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  const sets: string[] = []
  const params: unknown[] = []
  if (parsed.title !== undefined) { params.push(parsed.title); sets.push(`title = $${params.length}`) }
  if (parsed.status !== undefined) { params.push(parsed.status); sets.push(`status = $${params.length}`) }
  if (parsed.agentId !== undefined) { params.push(parsed.agentId); sets.push(`agent_id = $${params.length}`) }
  if (parsed.flowId !== undefined) { params.push(parsed.flowId); sets.push(`flow_id = $${params.length}`) }
  if (sets.length === 0) return fail(c, 400, 'nothing to update')

  params.push(id)
  sets.push(`updated_at = NOW()`)

  try {
    const { records } = await runQuery<ChatRow>(
      `UPDATE "chats" SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, directory_id, title, status, agent_id, flow_id, last_message,
                 message_count, last_run_id, created_at, updated_at`,
      params,
    )
    const row = records[0]
    if (!row) return fail(c, 404, 'chat not found', { id })
    return ok(c, { chat: normalizeChat(row) })
  } catch (err) {
    log.error('chat update failed', { id, error: String(err) })
    return fail(c, 502, 'chat update failed')
  }
})

chatRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid chat id', { id })

  try {
    const { affected } = await runQuery(`DELETE FROM "chats" WHERE id = $1`, [id])
    if (affected === 0) return fail(c, 404, 'chat not found', { id })
    return ok(c, { deleted: true, id })
  } catch (err) {
    log.error('chat delete failed', { id, error: String(err) })
    return fail(c, 502, 'chat delete failed')
  }
})

const msgSendBodySchema = z.object({
  content: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  runId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
})

chatRoutes.post('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid chat id', { id })

  let parsed: z.infer<typeof msgSendBodySchema>
  try {
    parsed = msgSendBodySchema.parse(await c.req.json())
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  try {
    const chatCheck = await runQuery(`SELECT id FROM chats WHERE id = $1`, [id])
    if (chatCheck.records.length === 0) {
      return fail(c, 404, 'chat not found', { id })
    }

    const { records } = await runQuery<MsgRow>(
      `INSERT INTO "chat_messages" (chat_id, role, content, run_id, metadata)
       VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))
       RETURNING id, chat_id, role, content, run_id, metadata, created_at`,
      [id, parsed.role, parsed.content, parsed.runId ?? null, parsed.metadata ?? null],
    )

    await runQuery(
      `UPDATE "chats" SET last_message = $1, message_count = message_count + 1, updated_at = NOW() WHERE id = $2`,
      [parsed.content.slice(0, 200), id],
    )

    return ok(c, { message: normalizeMsg(records[0]!) })
  } catch (err) {
    log.error('chat message send failed', { id, error: String(err) })
    return fail(c, 502, 'chat message send failed')
  }
})

chatRoutes.get('/:id/messages', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return fail(c, 400, 'invalid chat id', { id })

  const parsed = msgListQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return fail(c, 400, 'invalid query', { detail: parsed.error.message })
  const q = parsed.data

  const params: unknown[] = [id]
  const clauses: string[] = ['chat_id = $1']
  if (q.before && q.beforeId) {
    params.push(q.before, q.beforeId)
    clauses.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`)
  } else if (q.before) {
    params.push(q.before)
    clauses.push(`created_at < $${params.length}`)
  }
  params.push(q.limit + 1)

  try {
    const { records } = await runQuery<MsgRow>(
      `SELECT id, chat_id, role, content, run_id, metadata, created_at
         FROM chat_messages
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ASC, id ASC
         LIMIT $${params.length}`,
      params,
    )
    const hasMore = records.length > q.limit
    const items = hasMore ? records.slice(0, q.limit) : records
    const last = items[items.length - 1]
    return ok(c, {
      items: items.map(normalizeMsg),
      hasMore,
      nextBefore: last ? (last.created_at instanceof Date ? last.created_at.toISOString() : new Date(last.created_at).toISOString()) : null,
      nextBeforeId: last ? last.id : null,
    })
  } catch (err) {
    log.error('chat messages list failed', { id, error: String(err) })
    return fail(c, 502, 'chat messages list failed')
  }
})
```

- [ ] **Step 4: Mount chat routes in gateway app.ts**

Add import:
```ts
import { chatRoutes } from './routes/chats.js'
```

And mount after directory routes:
```ts
app.route('/api/v1/chats', chatRoutes)
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm --filter @dagents/gateway test -- chats.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/routes/chats.ts \
        apps/gateway/src/__tests__/chats.test.ts \
        apps/gateway/src/app.ts
git commit -m "feat(gateway): add chats CRUD + messages list API"
```

---

### Task 2.3: Create console API proxy routes for directories

**Files:**
- Create: `apps/console/src/app/api/directories/route.ts`
- Create: `apps/console/src/app/api/directories/[id]/route.ts`
- Create: `apps/console/src/lib/directory-proxy.ts`

- [ ] **Step 1: Write failing test for directory proxy**

Create `apps/console/src/app/api/directories/route.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as listDirs } from './route'
import { GET as getDir } from './[id]/route'
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

function req(path: string, method = 'GET', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method, headers })
}

describe('GET /api/directories — list', () => {
  it('returns 502 when gateway is unreachable', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:1'
    const res = await listDirs(req('/api/directories'))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toBe('gateway unavailable')
  })

  it('forwards directory list verbatim', async () => {
    let receivedPath = ''
    await withStub((_req, res) => {
      receivedPath = _req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { items: [{ id: '1', name: 'Test' }] } }))
    })
    const res = await listDirs(req('/api/directories', 'GET', { 'x-run-id': 'run-dir-1' }))
    expect(res.status).toBe(200)
    expect(receivedPath).toBe('/api/v1/directories')
  })
})

describe('GET /api/directories/:id — detail', () => {
  it('forwards directory detail', async () => {
    let receivedPath = ''
    await withStub((_req, res) => {
      receivedPath = _req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { directory: { id: 'dir-1', name: 'D1' } } }))
    })
    const res = await getDir(req('/api/directories/dir-1'), {
      params: Promise.resolve({ id: 'dir-1' }),
    })
    expect(res.status).toBe(200)
    expect(receivedPath).toBe('/api/v1/directories/dir-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @dagents/console test -- directories/route.test.ts
```
Expected: test fails with module not found.

- [ ] **Step 3: Implement directory proxy helpers**

Create `apps/console/src/lib/directory-proxy.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@dagents/shared'
import { gatewayUrl, MAX_RUN_ID_LEN } from '@/lib/config'

const proxyLog = createLogger({ svc: 'console:directories-proxy' })

export function buildDirectoryUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/directories${path}`
  return search ? `${base}${search}` : base
}

export function forwardDirectoryHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {}
  const runId = req.headers.get('x-run-id')?.trim()
  if (runId && runId.length <= MAX_RUN_ID_LEN) headers['x-run-id'] = runId
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  return headers
}

export function directoryFail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

export function directoryLogProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}

export async function pipeDirectoryUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new NextResponse(body, { status: upstream.status, headers })
}
```

- [ ] **Step 4: Implement list route**

Create `apps/console/src/app/api/directories/route.ts`:

```ts
import { type NextRequest } from 'next/server'
import {
  buildDirectoryUpstreamUrl,
  forwardDirectoryHeaders,
  pipeDirectoryUpstream,
  directoryFail,
  directoryLogProxyError,
} from '@/lib/directory-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildDirectoryUpstreamUrl('', req.nextUrl.search), {
      method: 'GET',
      headers: forwardDirectoryHeaders(req),
      cache: 'no-store',
    })
  } catch (err) {
    directoryLogProxyError('list', err)
    return directoryFail(502, 'gateway unavailable')
  }
  return pipeDirectoryUpstream(upstream)
}

export async function POST(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildDirectoryUpstreamUrl('', req.nextUrl.search), {
      method: 'POST',
      headers: { ...forwardDirectoryHeaders(req), 'content-type': 'application/json' },
      body: await req.text(),
      cache: 'no-store',
    })
  } catch (err) {
    directoryLogProxyError('create', err)
    return directoryFail(502, 'gateway unavailable')
  }
  return pipeDirectoryUpstream(upstream)
}
```

- [ ] **Step 5: Implement detail route**

Create `apps/console/src/app/api/directories/[id]/route.ts`:

```ts
import { type NextRequest } from 'next/server'
import {
  buildDirectoryUpstreamUrl,
  forwardDirectoryHeaders,
  pipeDirectoryUpstream,
  directoryFail,
  directoryLogProxyError,
} from '@/lib/directory-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildDirectoryUpstreamUrl(`/${encodeURIComponent(id)}`, req.nextUrl.search),
      { method: 'GET', headers: forwardDirectoryHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    directoryLogProxyError('detail', err)
    return directoryFail(502, 'gateway unavailable')
  }
  return pipeDirectoryUpstream(upstream)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildDirectoryUpstreamUrl(`/${encodeURIComponent(id)}`, req.nextUrl.search),
      {
        method: 'PATCH',
        headers: { ...forwardDirectoryHeaders(req), 'content-type': 'application/json' },
        body: await req.text(),
        cache: 'no-store',
      },
    )
  } catch (err) {
    directoryLogProxyError('update', err)
    return directoryFail(502, 'gateway unavailable')
  }
  return pipeDirectoryUpstream(upstream)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(buildDirectoryUpstreamUrl(`/${encodeURIComponent(id)}`, ''), {
      method: 'DELETE',
      cache: 'no-store',
    })
  } catch (err) {
    directoryLogProxyError('delete', err)
    return directoryFail(502, 'gateway unavailable')
  }
  return pipeDirectoryUpstream(upstream)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
pnpm --filter @dagents/console test -- directories/route.test.ts
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/console/src/lib/directory-proxy.ts \
        apps/console/src/app/api/directories/route.ts \
        apps/console/src/app/api/directories/[id]/route.ts \
        apps/console/src/app/api/directories/route.test.ts
git commit -m "feat(console): add directories API proxy routes"
```

---

### Task 2.4: Create console API proxy routes for chats

**Files:**
- Create: `apps/console/src/app/api/chats/route.ts`
- Create: `apps/console/src/app/api/chats/[id]/route.ts`
- Create: `apps/console/src/app/api/chats/[id]/messages/route.ts`
- Create: `apps/console/src/lib/chat-proxy.ts`

- [ ] **Step 1: Write failing test for chats proxy**

Create `apps/console/src/app/api/chats/route.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as listChats, POST as createChat } from './route'
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

function req(path: string, method = 'GET', body?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body,
  })
}

describe('GET /api/chats — list', () => {
  it('forwards chat list to gateway', async () => {
    let receivedPath = ''
    await withStub((_req, res) => {
      receivedPath = _req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { items: [] } }))
    })
    const res = await listChats(req('/api/chats?directory_id=test'))
    expect(res.status).toBe(200)
    expect(receivedPath).toBe('/api/v1/chats?directory_id=test')
  })
})

describe('POST /api/chats — create', () => {
  it('forwards create body to gateway', async () => {
    let receivedBody = ''
    await withStub(async (_req, res) => {
      let data = ''
      for await (const chunk of _req) data += chunk
      receivedBody = data
      res.setHeader('content-type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({ success: true, data: { chat: { id: 'c1', title: 'New' } } }))
    })
    const res = await createChat(req('/api/chats', 'POST', JSON.stringify({ directoryId: 'd1', title: 'New' })))
    expect(res.status).toBe(200)
    const parsed = JSON.parse(receivedBody)
    expect(parsed.directoryId).toBe('d1')
    expect(parsed.title).toBe('New')
  })
})
```

- [ ] **Step 2: Implement chat proxy helpers**

Create `apps/console/src/lib/chat-proxy.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@dagents/shared'
import { gatewayUrl, MAX_RUN_ID_LEN } from '@/lib/config'

const proxyLog = createLogger({ svc: 'console:chats-proxy' })

export function buildChatUpstreamUrl(path: string, search: string): string {
  const base = `${gatewayUrl()}/api/v1/chats${path}`
  return search ? `${base}${search}` : base
}

export function forwardChatHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {}
  const runId = req.headers.get('x-run-id')?.trim()
  if (runId && runId.length <= MAX_RUN_ID_LEN) headers['x-run-id'] = runId
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth
  const cookie = req.headers.get('cookie')
  if (cookie) headers['cookie'] = cookie
  return headers
}

export function chatFail(status: number, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status })
}

export function chatLogProxyError(stage: string, err: unknown): void {
  proxyLog.error('gateway dial failed', {
    stage,
    error: err instanceof Error ? err.name : typeof err,
  })
}

export async function pipeChatUpstream(upstream: Response): Promise<NextResponse> {
  const body = await upstream.text()
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new NextResponse(body, { status: upstream.status, headers })
}
```

- [ ] **Step 3: Implement chats list/create route**

Create `apps/console/src/app/api/chats/route.ts`:

```ts
import { type NextRequest } from 'next/server'
import {
  buildChatUpstreamUrl,
  forwardChatHeaders,
  pipeChatUpstream,
  chatFail,
  chatLogProxyError,
} from '@/lib/chat-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildChatUpstreamUrl('', req.nextUrl.search), {
      method: 'GET',
      headers: forwardChatHeaders(req),
      cache: 'no-store',
    })
  } catch (err) {
    chatLogProxyError('list', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}

export async function POST(req: NextRequest): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(buildChatUpstreamUrl('', req.nextUrl.search), {
      method: 'POST',
      headers: { ...forwardChatHeaders(req), 'content-type': 'application/json' },
      body: await req.text(),
      cache: 'no-store',
    })
  } catch (err) {
    chatLogProxyError('create', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}
```

- [ ] **Step 4: Implement chat detail/update/delete route**

Create `apps/console/src/app/api/chats/[id]/route.ts`:

```ts
import { type NextRequest } from 'next/server'
import {
  buildChatUpstreamUrl,
  forwardChatHeaders,
  pipeChatUpstream,
  chatFail,
  chatLogProxyError,
} from '@/lib/chat-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildChatUpstreamUrl(`/${encodeURIComponent(id)}`, req.nextUrl.search),
      { method: 'GET', headers: forwardChatHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    chatLogProxyError('detail', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildChatUpstreamUrl(`/${encodeURIComponent(id)}`, req.nextUrl.search),
      {
        method: 'PATCH',
        headers: { ...forwardChatHeaders(req), 'content-type': 'application/json' },
        body: await req.text(),
        cache: 'no-store',
      },
    )
  } catch (err) {
    chatLogProxyError('update', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(buildChatUpstreamUrl(`/${encodeURIComponent(id)}`, ''), {
      method: 'DELETE',
      cache: 'no-store',
    })
  } catch (err) {
    chatLogProxyError('delete', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}
```

- [ ] **Step 5: Implement chat messages route**

Create `apps/console/src/app/api/chats/[id]/messages/route.ts`:

```ts
import { type NextRequest } from 'next/server'
import {
  buildChatUpstreamUrl,
  forwardChatHeaders,
  pipeChatUpstream,
  chatFail,
  chatLogProxyError,
} from '@/lib/chat-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildChatUpstreamUrl(`/${encodeURIComponent(id)}/messages`, req.nextUrl.search),
      { method: 'GET', headers: forwardChatHeaders(req), cache: 'no-store' },
    )
  } catch (err) {
    chatLogProxyError('messages-list', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  let upstream: Response
  try {
    upstream = await fetch(
      buildChatUpstreamUrl(`/${encodeURIComponent(id)}/messages`, req.nextUrl.search),
      {
        method: 'POST',
        headers: { ...forwardChatHeaders(req), 'content-type': 'application/json' },
        body: await req.text(),
        cache: 'no-store',
      },
    )
  } catch (err) {
    chatLogProxyError('messages-send', err)
    return chatFail(502, 'gateway unavailable')
  }
  return pipeChatUpstream(upstream)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
pnpm --filter @dagents/console test -- chats/route.test.ts
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/console/src/lib/chat-proxy.ts \
        apps/console/src/app/api/chats/route.ts \
        apps/console/src/app/api/chats/[id]/route.ts \
        apps/console/src/app/api/chats/[id]/messages/route.ts \
        apps/console/src/app/api/chats/route.test.ts
git commit -m "feat(console): add chats API proxy routes"
```

---

## Phase 3: Frontend — Chat Home + Chat Detail + Directories Page

### Task 3.1: Create shared API hooks (directories + chats)

**Files:**
- Create: `apps/console/src/hooks/use-directories.ts`
- Create: `apps/console/src/hooks/use-chats.ts`

- [ ] **Step 1: Create use-directories hook**

Create `apps/console/src/hooks/use-directories.ts`:

```ts
'use client'

import { useState, useCallback, useEffect } from 'react'

export interface Directory {
  id: string
  path: string
  name: string
  settings: Record<string, unknown>
  chatCount: number
  createdAt: string
  updatedAt: string
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export function useDirectories() {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchDirectories = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/directories')
      const body: ApiResponse<{ items: Directory[] }> = await res.json()
      if (body.success && body.data) {
        setDirectories(body.data.items)
      } else {
        setError(body.error ?? 'failed to load directories')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const createDirectory = useCallback(async (path: string, name?: string) => {
    const res = await fetch('/api/directories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, name }),
    })
    const body: ApiResponse<{ directory: Directory }> = await res.json()
    if (body.success && body.data) {
      setDirectories((prev) => [body.data!.directory, ...prev])
      return body.data.directory
    }
    throw new Error(body.error ?? 'failed to create directory')
  }, [])

  const updateDirectory = useCallback(async (id: string, updates: Partial<Pick<Directory, 'name' | 'settings'>>) => {
    const res = await fetch(`/api/directories/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const body: ApiResponse<{ directory: Directory }> = await res.json()
    if (body.success && body.data) {
      setDirectories((prev) => prev.map((d) => d.id === id ? body.data!.directory : d))
      return body.data.directory
    }
    throw new Error(body.error ?? 'failed to update directory')
  }, [])

  const deleteDirectory = useCallback(async (id: string) => {
    const res = await fetch(`/api/directories/${id}`, { method: 'DELETE' })
    const body = await res.json()
    if (body.success) {
      setDirectories((prev) => prev.filter((d) => d.id !== id))
      return true
    }
    throw new Error(body.error ?? 'failed to delete directory')
  }, [])

  useEffect(() => {
    fetchDirectories()
  }, [fetchDirectories])

  return { directories, loading, error, refetch: fetchDirectories, createDirectory, updateDirectory, deleteDirectory }
}
```

- [ ] **Step 2: Create use-chats hook**

Create `apps/console/src/hooks/use-chats.ts`:

```ts
'use client'

import { useState, useCallback, useEffect } from 'react'

export interface Chat {
  id: string
  directoryId: string
  title: string
  status: 'idle' | 'running' | 'done' | 'failed'
  agentId: string | null
  flowId: string | null
  lastMessage: string | null
  messageCount: number
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  runId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export function useChats(directoryId?: string) {
  const [chats, setChats] = useState<Chat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchChats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = directoryId
        ? `/api/chats?directory_id=${directoryId}`
        : '/api/chats'
      const res = await fetch(url)
      const body: ApiResponse<{ items: Chat[] }> = await res.json()
      if (body.success && body.data) {
        setChats(body.data.items)
      } else {
        setError(body.error ?? 'failed to load chats')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [directoryId])

  const createChat = useCallback(async (directoryId: string, title?: string) => {
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directoryId, title }),
    })
    const body: ApiResponse<{ chat: Chat }> = await res.json()
    if (body.success && body.data) {
      setChats((prev) => [body.data!.chat, ...prev])
      return body.data.chat
    }
    throw new Error(body.error ?? 'failed to create chat')
  }, [])

  const deleteChat = useCallback(async (id: string) => {
    const res = await fetch(`/api/chats/${id}`, { method: 'DELETE' })
    const body = await res.json()
    if (body.success) {
      setChats((prev) => prev.filter((c) => c.id !== id))
      return true
    }
    throw new Error(body.error ?? 'failed to delete chat')
  }, [])

  useEffect(() => {
    fetchChats()
  }, [fetchChats])

  return { chats, loading, error, refetch: fetchChats, createChat, deleteChat }
}

export function useChatMessages(chatId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [nextBeforeId, setNextBeforeId] = useState<string | null>(null)

  const fetchMessages = useCallback(async (before?: string, beforeId?: string) => {
    if (!chatId) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (before) params.set('before', before)
      if (beforeId) params.set('beforeId', beforeId)
      const qs = params.toString()
      const res = await fetch(`/api/chats/${chatId}/messages${qs ? `?${qs}` : ''}`)
      const body: ApiResponse<{ items: ChatMessage[]; hasMore: boolean; nextBefore: string | null; nextBeforeId: string | null }> = await res.json()
      if (body.success && body.data) {
        if (before) {
          setMessages((prev) => [...body.data!.items, ...prev])
        } else {
          setMessages(body.data.items)
        }
        setHasMore(body.data.hasMore)
        setNextBefore(body.data.nextBefore)
        setNextBeforeId(body.data.nextBeforeId)
      } else {
        setError(body.error ?? 'failed to load messages')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [chatId])

  const sendMessage = useCallback(async (content: string) => {
    if (!chatId) throw new Error('no chat id')
    const res = await fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    const body: ApiResponse<{ message: ChatMessage }> = await res.json()
    if (body.success && body.data) {
      setMessages((prev) => [...prev, body.data!.message])
      return body.data.message
    }
    throw new Error(body.error ?? 'failed to send message')
  }, [chatId])

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  useEffect(() => {
    setMessages([])
    setHasMore(false)
    setNextBefore(null)
    setNextBeforeId(null)
    if (chatId) {
      fetchMessages()
    }
  }, [chatId, fetchMessages])

  return { messages, loading, error, hasMore, loadMore: () => nextBefore ? fetchMessages(nextBefore, nextBeforeId ?? undefined) : Promise.resolve(), sendMessage, appendMessage }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/console/src/hooks/use-directories.ts \
        apps/console/src/hooks/use-chats.ts
git commit -m "feat(console): add use-directories and use-chats hooks"
```

---

### Task 3.2: Create chat sidebar component (directory + chat list)

**Files:**
- Create: `apps/console/src/components/chat-sidebar.tsx`

- [ ] **Step 1: Create chat sidebar component**

Create `apps/console/src/components/chat-sidebar.tsx`:

```tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useDirectories } from '@/hooks/use-directories'
import { useChats } from '@/hooks/use-chats'
import { useRouter } from 'next/navigation'

const statusDot: Record<string, string> = {
  idle: 'bg-gray-400',
  running: 'bg-green-500 animate-pulse',
  done: 'bg-blue-500',
  failed: 'bg-red-500',
}

export function ChatSidebar() {
  const { directories, loading: dirsLoading } = useDirectories()
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [activeDirId, setActiveDirId] = useState<string | null>(null)
  const router = useRouter()

  const toggleDir = (id: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectDir = (id: string) => {
    setActiveDirId(id)
    if (!expandedDirs.has(id)) toggleDir(id)
  }

  const startNewChat = async (dirId: string) => {
    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directoryId: dirId, title: 'New Chat' }),
      })
      const body = await res.json()
      if (body.success && body.data?.chat) {
        router.push(`/chats/${body.data.chat.id}`)
      }
    } catch {
      console.error('failed to create chat')
    }
  }

  return (
    <div className="flex h-full flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-800">项目目录</h2>
        <button className="text-xs text-gray-500 hover:text-gray-700">+ 添加</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {dirsLoading && (
          <div className="px-4 py-2 text-xs text-gray-400">加载中...</div>
        )}

        {directories.map((dir) => (
          <div key={dir.id} className="border-b border-gray-100">
            <button
              onClick={() => selectDir(dir.id)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50 ${activeDirId === dir.id ? 'bg-gray-50' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-gray-400">{expandedDirs.has(dir.id) ? '▾' : '▸'}</span>
                <span className="text-sm font-medium text-gray-700">📁 {dir.name}</span>
              </div>
              <span className="text-xs text-gray-400">{dir.chatCount}</span>
            </button>

            {expandedDirs.has(dir.id) && (
              <DirectoryChatList dirId={dir.id} onNewChat={() => startNewChat(dir.id)} />
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 p-3">
        <Link
          href="/directories"
          className="block text-center text-xs text-gray-500 hover:text-gray-700"
        >
          管理目录
        </Link>
      </div>
    </div>
  )
}

function DirectoryChatList({ dirId, onNewChat }: { dirId: string; onNewChat: () => void }) {
  const { chats, loading } = useChats(dirId)

  return (
    <div className="ml-6">
      <button
        onClick={onNewChat}
        className="w-full px-3 py-1.5 text-left text-xs text-blue-600 hover:bg-blue-50"
      >
        + 新对话
      </button>
      {loading && <div className="px-3 py-1 text-xs text-gray-400">加载中...</div>}
      {chats.map((chat) => (
        <Link
          key={chat.id}
          href={`/chats/${chat.id}`}
          className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50"
        >
          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${statusDot[chat.status] ?? 'bg-gray-300'}`} />
          <span className="truncate text-gray-600">{chat.title}</span>
        </Link>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/console/src/components/chat-sidebar.tsx
git commit -m "feat(console): add chat sidebar with directory + chat list"
```

---

### Task 3.3: Create Chat Home page (`/`)

**Files:**
- Create: `apps/console/src/app/layout.tsx` — or verify existing app layout
- Create: `apps/console/src/app/(chat)/layout.tsx`
- Create: `apps/console/src/app/(chat)/page.tsx`
- Create: `apps/console/src/components/chat-home.tsx`

- [ ] **Step 1: Verify existing app layout**

Read `apps/console/src/app/layout.tsx` to understand the root layout structure. If it already exists with a sidebar/layout pattern, skip this step and note the existing structure for reference.

- [ ] **Step 2: Create (chat) layout group**

Create `apps/console/src/app/(chat)/layout.tsx`:

```tsx
import { ChatSidebar } from '@/components/chat-sidebar'

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <div className="w-64 flex-shrink-0">
        <ChatSidebar />
      </div>
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Create chat home server page**

Create `apps/console/src/app/(chat)/page.tsx`:

```tsx
import { ChatHome } from '@/components/chat-home'

export default function ChatHomePage() {
  return <ChatHome />
}
```

- [ ] **Step 4: Create chat home client component**

Create `apps/console/src/components/chat-home.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useDirectories } from '@/hooks/use-directories'
import { useRouter } from 'next/navigation'

const suggestionCards = [
  { icon: '⚡', title: '创建 AgentFlow', desc: '用可视化画布构建工作流', href: '/flows' },
  { icon: '🤖', title: '查看 Agent 状态', desc: '浏览可用代理和运行状态', href: '/agents' },
  { icon: '🔧', title: '设计任务', desc: '描述你的需求，让 AI 规划方案', href: '#' },
  { icon: '💬', title: '测试 Prompt', desc: '快速验证提示词效果', href: '#' },
]

export function ChatHome() {
  const { directories } = useDirectories()
  const [selectedDirId, setSelectedDirId] = useState<string>('')
  const [input, setInput] = useState('')
  const router = useRouter()

  const handleSend = async () => {
    if (!input.trim()) return
    const dirId = selectedDirId || directories[0]?.id
    if (!dirId) return

    try {
      const createRes = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          directoryId: dirId,
          title: input.slice(0, 50),
        }),
      })
      const createBody = await createRes.json()
      if (!createBody.success || !createBody.data?.chat) {
        throw new Error(createBody.error ?? 'failed to create chat')
      }
      const chatId = createBody.data.chat.id

      await fetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: input.trim(), role: 'user' }),
      })

      router.push(`/chats/${chatId}`)
    } catch (err) {
      console.error('failed to start chat:', err)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 px-6 py-3">
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-500">项目目录:</label>
          <select
            value={selectedDirId}
            onChange={(e) => setSelectedDirId(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">选择目录</option>
            {directories.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-3xl px-6">
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-bold text-gray-800">有什么我可以帮你的？</h1>
            <p className="mt-2 text-gray-500">选择项目目录，开始新的对话</p>
          </div>

          <div className="mb-8 grid grid-cols-2 gap-4">
            {suggestionCards.map((card) => (
              <a
                key={card.title}
                href={card.href}
                className="rounded-lg border border-gray-200 p-4 transition-colors hover:border-blue-300 hover:bg-blue-50"
              >
                <div className="text-2xl">{card.icon}</div>
                <div className="mt-2 font-medium text-gray-800">{card.title}</div>
                <div className="text-sm text-gray-500">{card.desc}</div>
              </a>
            ))}
          </div>

          <div className="rounded-lg border border-gray-300 bg-white shadow-sm">
            <div className="flex items-center gap-2 px-4 py-3">
              <select className="text-sm text-gray-500 focus:outline-none">
                <option>auto</option>
              </select>
              <div className="h-5 w-px bg-gray-300" />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                placeholder="输入消息，开始对话..."
                className="flex-1 text-sm focus:outline-none"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300 hover:bg-blue-700"
              >
                发送
              </button>
            </div>
            <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
              ⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/(chat)/layout.tsx \
        apps/console/src/app/(chat)/page.tsx \
        apps/console/src/components/chat-home.tsx
git commit -m "feat(console): add chat home page with directory selector"
```

---

### Task 3.4: Create chat detail page (`/chats/[id]`)

**Files:**
- Create: `apps/console/src/app/(chat)/chats/[id]/page.tsx`
- Create: `apps/console/src/components/chat-detail.tsx`

- [ ] **Step 1: Create chat detail server page**

Create `apps/console/src/app/(chat)/chats/[id]/page.tsx`:

```tsx
import { ChatDetail } from '@/components/chat-detail'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ChatDetailPage({ params }: Props) {
  const { id } = await params
  return <ChatDetail chatId={id} />
}
```

- [ ] **Step 2: Create chat detail client component**

Create `apps/console/src/components/chat-detail.tsx`:

```tsx
'use client'

import { useState, useRef, useEffect } from 'react'
import { useChatMessages } from '@/hooks/use-chats'
import Link from 'next/link'

const roleStyles: Record<string, string> = {
  user: 'bg-blue-50 border-blue-100',
  assistant: 'bg-white border-gray-200',
  system: 'bg-yellow-50 border-yellow-100',
  tool: 'bg-gray-50 border-gray-200',
}

const roleLabels: Record<string, string> = {
  user: '你',
  assistant: '助手',
  system: '系统',
  tool: '工具',
}

export function ChatDetail({ chatId }: { chatId: string }) {
  const { messages, loading, sendMessage, appendMessage } = useChatMessages(chatId)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || sending) return
    const content = input.trim()
    setInput('')
    setSending(true)

    try {
      await sendMessage(content)
    } catch (err) {
      console.error('send failed:', err)
      appendMessage({
        id: `err-${Date.now()}`,
        chatId,
        role: 'system',
        content: `发送失败: ${err instanceof Error ? err.message : String(err)}`,
        runId: null,
        metadata: {},
        createdAt: new Date().toISOString(),
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2 text-sm">
          <Link href="/" className="text-gray-500 hover:text-gray-700">
            ← 返回
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-gray-700">Chat ID: {chatId.slice(0, 8)}...</span>
          <span className="text-xs text-gray-400">{messages.length} 条消息</span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
          {loading && messages.length === 0 && (
            <div className="text-center text-sm text-gray-400">加载消息中...</div>
          )}

          {messages.length === 0 && !loading && (
            <div className="py-12 text-center text-sm text-gray-400">
              还没有消息，开始对话吧
            </div>
          )}

          <div className="space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-lg border p-4 ${roleStyles[msg.role] ?? 'bg-white border-gray-200'}`}
              >
                <div className="mb-1 text-xs font-medium text-gray-500">
                  {roleLabels[msg.role] ?? msg.role}
                  <span className="ml-2 text-gray-300">{new Date(msg.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="whitespace-pre-wrap text-sm text-gray-800">{msg.content}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-gray-200 p-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
              placeholder="输入消息..."
              disabled={sending}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300 hover:bg-blue-700"
            >
              {sending ? '发送中...' : '发送'}
            </button>
          </div>
        </div>
      </div>

      <div className="w-64 flex-shrink-0 border-l border-gray-200 bg-gray-50 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-800">上下文</h3>
        <div className="space-y-3 text-xs text-gray-600">
          <div>
            <div className="text-gray-400">所属目录</div>
            <div className="mt-1 truncate">—</div>
          </div>
          <div>
            <div className="text-gray-400">绑定 Agent</div>
            <div className="mt-1">未设置</div>
          </div>
          <div>
            <div className="text-gray-400">绑定 Flow</div>
            <div className="mt-1">未设置</div>
          </div>
          <div>
            <div className="text-gray-400">消息数</div>
            <div className="mt-1">{messages.length}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/console/src/app/(chat)/chats/[id]/page.tsx \
        apps/console/src/components/chat-detail.tsx
git commit -m "feat(console): add chat detail page with message list"
```

---

### Task 3.5: Create directories management page (`/directories`)

**Files:**
- Create: `apps/console/src/app/directories/page.tsx`
- Create: `apps/console/src/components/directories-view.tsx`

- [ ] **Step 1: Create directories server page**

Create `apps/console/src/app/directories/page.tsx`:

```tsx
import { DirectoriesView } from '@/components/directories-view'

export default function DirectoriesPage() {
  return <DirectoriesView />
}
```

- [ ] **Step 2: Create directories view component**

Create `apps/console/src/components/directories-view.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useDirectories, type Directory } from '@/hooks/use-directories'
import Link from 'next/link'

export function DirectoriesView() {
  const { directories, loading, error, createDirectory, deleteDirectory } = useDirectories()
  const [showAdd, setShowAdd] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    if (!newPath.trim()) return
    setCreating(true)
    try {
      await createDirectory(newPath.trim(), newName.trim() || undefined)
      setNewPath('')
      setNewName('')
      setShowAdd(false)
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定要删除目录「${name}」吗？其下所有对话都会被删除。`)) return
    try {
      await deleteDirectory(id)
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">项目目录</h1>
          <p className="mt-1 text-sm text-gray-500">管理你的项目目录，每个目录下可以有多个对话</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + 添加目录
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {showAdd && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-800">添加新项目目录</h3>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-gray-500">路径</label>
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="/path/to/your/project"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">名称 (可选)</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="显示名称，留空用路径最后一段"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={creating || !newPath.trim()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300 hover:bg-blue-700"
              >
                {creating ? '添加中...' : '添加'}
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">加载中...</div>
      ) : directories.length === 0 ? (
        <div className="py-12 text-center text-sm text-gray-400">
          还没有目录，点击右上角添加
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {directories.map((dir) => (
            <DirectoryCard key={dir.id} dir={dir} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  )
}

function DirectoryCard({ dir, onDelete }: { dir: Directory; onDelete: (id: string, name: string) => void }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="mb-2 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">📁</span>
          <h3 className="font-medium text-gray-800">{dir.name}</h3>
        </div>
        <button
          onClick={() => onDelete(dir.id, dir.name)}
          className="text-xs text-red-500 hover:text-red-700"
        >
          删除
        </button>
      </div>
      <p className="mb-3 truncate text-xs text-gray-500">{dir.path}</p>
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{dir.chatCount} 个对话</span>
        <Link href="/" className="text-blue-500 hover:text-blue-700">
          开始对话 →
        </Link>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/console/src/app/directories/page.tsx \
        apps/console/src/components/directories-view.tsx
git commit -m "feat(console): add directories management page"
```

---

### Task 3.6: Verify the app builds and run typecheck

**Files:** none — verification only

- [ ] **Step 1: Run TypeScript typecheck**

Run:
```bash
pnpm --filter @dagents/console build
```
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 2: Run all tests**

Run:
```bash
pnpm --filter @dagents/gateway test
pnpm --filter @dagents/console test
```
Expected: all existing tests pass (no regressions).

- [ ] **Step 3: Start dev server and smoke test**

Run:
```bash
pnpm --filter @dagents/gateway dev
```
In another terminal:
```bash
pnpm --filter @dagents/console dev
```
Then manually verify:
- `/` shows chat home with directory selector
- `/directories` shows directory management page
- Creating a directory works
- Creating a chat works
- Chat detail page loads

- [ ] **Step 4: Commit (if any fixes were needed)**

```bash
git add .
git commit -m "fix: resolve typecheck/build issues for chat-first frontend"
```

---

## Phase 4: Compatibility & Cleanup (Deferred)

These tasks are intentionally deferred — they clean up legacy workspace APIs and tables after phase 3 is fully working and users have migrated.

- Add read-only `/api/v1/workspaces` shim that returns directories data
- Deprecate `/api/workspaces` console proxy routes
- Drop `workspaces` / `workspace_members` / `workspace_flows` tables
- Remove `/dashboard` / `/lab` / `/launcher` / `/workspace` / `/chat` pages

---

## Summary

| Phase | Tasks | Deliverable |
|-------|-------|-------------|
| **1. Data Layer** | 1.1-1.3 | 3 new tables + data migration + 3 entities |
| **2. Backend API** | 2.1-2.4 | Gateway CRUD routes + console proxy routes for directories + chats |
| **3. Frontend** | 3.1-3.6 | Chat sidebar + Chat Home + Chat Detail + Directories page |
| **4. Cleanup** | deferred | Legacy workspace API deprecation + table drops |
