/**
 * Shared seed/cleanup helpers for the Chat-First e2e suite.
 *
 * Why this exists: 67 user-case specs need consistent DB seeding (directories,
 * chats, agents) and reliable cleanup. Centralizing the SQL + IDs-registry
 * keeps each spec focused on assertions, not on schema arcana.
 *
 * ## Approach
 *
 * - All seeds go through `@dagents/db` `runQuery` (the same layer gateway uses).
 * - `process.env.POSTGRES_URL` is set before the dynamic import so AppDataSource
 *   targets the dev-stack Postgres (:15432 by default).
 * - Each spec calls `createSeedContext()` in `beforeAll` to get a context that
 *   tracks seeded IDs, and `ctx.dispose()` in `afterAll` for cleanup. The
 *   dispose order respects FK constraints (messages → chats → directories).
 * - Functions return the minted UUIDs so specs can navigate to seeded pages
 *   without a second round-trip.
 *
 * ## Why dynamic import
 *
 * `@dagents/db` is not a declared console dependency (the console app itself never
 * touches the DB layer — only the gateway does). Pulling it in via a static
 * import would break the console's build graph. Dynamic import inside `beforeAll`
 * keeps it test-only tooling, same pattern as `v0.3-design.spec.ts`.
 */
import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'

/**
 * The dev-stack Postgres (compose remaps 5432→15432 to avoid host collisions).
 * Override via env when pointing at a different stack.
 */
export const E2E_POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

export const GATEWAY_BASE = process.env.E2E_GATEWAY_URL ?? 'http://localhost:8080'
export const DISPATCH_BASE = `${GATEWAY_BASE}/api/v1/dispatch`

export interface SeedContext {
  /** Directory IDs created by this spec — cleaned up in dispose(). */
  directoryIds: string[]
  /** Chat IDs created by this spec — cleaned up in dispose(). */
  chatIds: string[]
  /** Agent IDs (agents + agent_daemons rows) created by this spec. */
  agentIds: string[]
  /** Daemon IDs (daemons rows) created by this spec. */
  daemonIds: string[]
  /** Workspace IDs created by this spec — cleaned up after agents. */
  workspaceIds: string[]
  /** Message IDs created by this spec — cleaned up before chats. */
  messageIds: string[]
  /** Resolved runQuery + initDb from the dynamic import. `initDb` returns the
   *  DataSource (typed `Promise<unknown>` here so the helper doesn't have to
   *  depend on `@dagents/db`'s `DataSource` type — callers `await` it for its side
   *  effect and ignore the returned handle). */
  db: {
    runQuery: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ records: T[] }>
    initDb: () => Promise<unknown>
  }
  /** Dispose all seeded rows. Safe to call multiple times. */
  dispose: () => Promise<void>
}

/**
 * Build a seed context. Sets POSTGRES_URL on process.env *before* dynamically
 * importing `@dagents/db` (the DataSource captures the env at module-construction
 * time — a static import would already be locked to the wrong URL).
 */
export async function createSeedContext(): Promise<SeedContext> {
  process.env.POSTGRES_URL = E2E_POSTGRES_URL
  const { initDb, runQuery } = await import('@dagents/db')
  await initDb()

  const ctx: SeedContext = {
    directoryIds: [],
    chatIds: [],
    agentIds: [],
    daemonIds: [],
    workspaceIds: [],
    messageIds: [],
    db: { runQuery, initDb },
    async dispose() {
      // Order matters: messages → chats → directories;
      // agent_daemons → agents → daemons → workspaces.
      // `agents` has no FK cascade to `workspaces`, so agents must be deleted
      // before workspaces (deleting the workspace first would orphan agent rows).
      if (this.messageIds.length) {
        await runQuery(`DELETE FROM chat_messages WHERE id = ANY($1::uuid[])`, [this.messageIds])
      }
      if (this.chatIds.length) {
        await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [this.chatIds])
      }
      if (this.directoryIds.length) {
        await runQuery(`DELETE FROM directories WHERE id = ANY($1::uuid[])`, [this.directoryIds])
      }
      if (this.agentIds.length) {
        await runQuery(`DELETE FROM agent_daemons WHERE id = ANY($1::uuid[])`, [this.agentIds])
      }
      if (this.agentIds.length) {
        await runQuery(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [this.agentIds])
      }
      if (this.daemonIds.length) {
        await runQuery(`DELETE FROM daemons WHERE id = ANY($1::uuid[])`, [this.daemonIds])
      }
      if (this.workspaceIds.length) {
        await runQuery(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [this.workspaceIds])
      }
    },
  }
  return ctx
}

/**
 * Seed a directory row. `path` defaults to a synthetic test path so it never
 * collides with a real workspace path the dev stack may already track.
 */
export async function seedDirectory(
  ctx: SeedContext,
  opts: { name?: string; path?: string; settings?: Record<string, unknown> } = {},
): Promise<string> {
  const id = randomUUID()
  const path = opts.path ?? `/e2e/${id.slice(0, 8)}`
  const name = opts.name ?? `E2E Dir ${id.slice(0, 8)}`
  await ctx.db.runQuery(
    `INSERT INTO directories (id, path, name, settings) VALUES ($1, $2, $3, $4)`,
    [id, path, name, JSON.stringify(opts.settings ?? {})],
  )
  ctx.directoryIds.push(id)
  return id
}

/**
 * Seed a chat row. Caller can bind an agentId/flowId to exercise different
 * routing paths (default agent, @flow, @daemon, @agent override).
 */
export async function seedChat(
  ctx: SeedContext,
  opts: { directoryId: string; title?: string; agentId?: string | null; flowId?: string | null },
): Promise<string> {
  const id = randomUUID()
  await ctx.db.runQuery(
    `INSERT INTO chats (id, directory_id, title, agent_id, flow_id) VALUES ($1, $2, $3, $4, $5)`,
    [id, opts.directoryId, opts.title ?? `E2E Chat ${id.slice(0, 8)}`, opts.agentId ?? null, opts.flowId ?? null],
  )
  ctx.chatIds.push(id)
  return id
}

/**
 * Seed a chat message row. Used to set up chats with prior history before the
 * spec opens them in the browser.
 */
export async function seedMessage(
  ctx: SeedContext,
  opts: {
    chatId: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    runId?: string | null
    metadata?: Record<string, unknown>
  },
): Promise<string> {
  const id = randomUUID()
  await ctx.db.runQuery(
    `INSERT INTO chat_messages (id, chat_id, role, content, run_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, opts.chatId, opts.role, opts.content, opts.runId ?? null, JSON.stringify(opts.metadata ?? {})],
  )
  ctx.messageIds.push(id)
  return id
}

/**
 * Seed a daemon host via the real dispatch API + an `agents` table row (the
 * gateway's primary table) + an `agent_daemons` catalogue row (runtime fields
 * for the gateway's LEFT JOIN). Mirrors the
 * apps/gateway/src/__tests__/agents-shape.test.ts seedAgent pattern for the
 * `agents` insert, but also keeps the daemon registration + agent_daemons row
 * so chat routing (which may still read agent_daemons) and the gateway's
 * runtime JOIN both resolve. Returns the agent id (the "agent id" the console
 * UI consumes) + the daemon id.
 *
 * The daemon is created with status 'online' so the agent-detail presence pill
 * can derive `online` (在线) for the happy path.
 */
export async function seedAgent(
  ctx: SeedContext,
  request: APIRequestContext,
  opts: { name?: string } = {},
): Promise<{ agentId: string; daemonId: string }> {
  const name = opts.name ?? `e2e-agent-${randomUUID().slice(0, 8)}`

  // Register the daemon host via the real dispatch API (the path the console
  // would hit in production). `endpoint` omitted — no real daemon process is
  // serving claims; the picker only needs the catalogue row to exist.
  const reg = await request.post(`${DISPATCH_BASE}/daemons/register`, {
    data: {
      daemonLabel: `e2e-daemon-${randomUUID().slice(0, 8)}`,
      capabilities: [{ agentType: 'claude', tags: ['e2e'] }],
    },
  })
  if (!reg.ok()) {
    throw new Error(`daemon register failed: ${reg.status()} ${await reg.text().catch(() => '')}`)
  }
  const regBody = (await reg.json()) as { data: { daemonId: string } }
  const daemonId = regBody.data.daemonId
  ctx.daemonIds.push(daemonId)

  // Seed a workspace — the gateway's `agents` table requires workspace_id.
  const workspaceId = randomUUID()
  await ctx.db.runQuery(
    `INSERT INTO workspaces (id, name, description, owner_user_id, status, quota, glyph)
     VALUES ($1, $2, NULL, NULL, 'active', '{}'::jsonb, 'W')`,
    [workspaceId, `e2e-ws-${workspaceId.slice(0, 8)}`],
  )
  ctx.workspaceIds.push(workspaceId)

  // Insert the agent_daemons catalogue row (runtime fields for the gateway's
  // LEFT JOIN). Same column set as the dispatch test helpers.
  const { records } = await ctx.db.runQuery<{ id: string }>(
    `INSERT INTO agent_daemons
       (name, kind, daemon_id, capability_descriptor, executable_path, visibility)
     VALUES ($1, 'claude', $2, $3::jsonb, 'claude', 'private')
     RETURNING id`,
    [
      name,
      daemonId,
      JSON.stringify({
        name,
        summary: 'e2e seed agent for Chat-First user-case suite',
        inputSchema: '{}',
        outputSchema: '{}',
        tags: ['e2e'],
      }),
    ],
  )
  const agentId = records[0]?.id
  if (!agentId) throw new Error('agent_daemons insert did not RETURNING an id')

  // Insert the agents table row (gateway's primary table). Same id as the
  // agent_daemons row so the LEFT JOIN picks up runtime fields. Follows the
  // apps/gateway/src/__tests__/agents-shape.test.ts seedAgent column set.
  await ctx.db.runQuery(
    `INSERT INTO agents (id, workspace_id, name, kind, roles, instructions, skills,
                         visibility, concurrency, model, runtime, owner_id,
                         status, availability, activity,
                         summary, input_schema, output_schema)
     VALUES ($1, $2, $3, 'claude', $4::jsonb, $5, $6::jsonb,
             'workspace', 1, '', '', 'e2e',
             'idle', 'offline', $7::jsonb,
             $8, '{}', '{}')`,
    [
      agentId,
      workspaceId,
      name,
      JSON.stringify(['e2e']),
      'e2e seed agent',
      JSON.stringify([]),
      JSON.stringify([{ total: 0, fail: 0 }]),
      'e2e seed agent for Chat-First user-case suite',
    ],
  )

  ctx.agentIds.push(agentId)
  return { agentId, daemonId }
}
