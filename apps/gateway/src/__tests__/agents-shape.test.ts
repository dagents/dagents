import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'

/**
 * Acceptance test for v0.3-M9.1 / 后端契约 1 (GET /agents/:id response shape).
 *
 * Source of truth: `design/js/agents-data.js` — the design's single-agent
 * object. The acceptance bar (plan M9.1): the detail response contains every
 * design field, with `summary` / `activity` / `owner` naming aligned (not
 * nested under a `capability` sub-object, not `owner_id`).
 *
 * Drives the gateway via Hono's in-process `app.request()` against the real
 * dagents Postgres (the platform-owned `agents` + `workspaces` +
 * `workspace_members` tables created by the domain migration). Each test seeds
 * its own workspace + agent (+ optional owner member) and wipes them so
 * assertions are on the rows this test wrote — never the shared dev rows other
 * suites rely on. `agents` has NO FK cascade to `workspaces` (no `REFERENCES`,
 * no `ON DELETE CASCADE` — `pg_constraint` returns 0 FK rows on the table), so
 * `cleanupSeeded()` deletes the seeded agents explicitly *before* the
 * workspaces; deleting the workspace first would orphan the agent rows and
 * leak them into the shared dev DB. (`workspace_members` / `workspace_flows`
 * DO cascade on workspace delete, so only `agents` needs the explicit pass.)
 *
 * Coverage:
 * - GET /:id returns every design field (the M9.1 acceptance set + the
 *   design's run-context + derived fields), with summary/activity/owner
 *   top-level and correctly typed
 * - `activity` buckets coerce to `{total,ok,fail}` (ok derived = total - fail)
 * - `owner` resolves to the member's display_name when an owner member row
 *   exists, else falls back to the raw owner_id
 * - `runCount` / `failCount` are stamped from `activity` (design L228-231)
 * - 400 on a malformed id, 404 when no row matches
 * - GET / lists design-shaped agents + a `truncated` flag
 */

const PG_URL =
  process.env.POSTGRES_URL ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

beforeAll(async () => {
  // `@dagents/db`'s DataSource captures POSTGRES_URL at module construction; set
  // it defensively for the dev stack remap (:15432), matching lab.test.ts.
  process.env.POSTGRES_URL ??= PG_URL
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

afterEach(async () => {
  await cleanupSeeded()
})

// Track the ids this test seeded so afterEach can wipe just them (never the
// shared dev rows). `agents` has no FK cascade to `workspaces`, so
// `cleanupSeeded` deletes the seeded agents by `workspace_id` first, then the
// workspaces — the order matters: deleting the workspace first would orphan the
// agents (workspace row gone, agents row left).
let seededWorkspaceIds: string[] = []

async function cleanupSeeded(): Promise<void> {
  if (seededWorkspaceIds.length === 0) return
  // `agents` has no `workspace_id REFERENCES workspaces` / `ON DELETE CASCADE`
  // (verified: 0 FK rows on `public.agents`), so deleting the workspace alone
  // would leak orphan agent rows into the shared dev DB. Delete this test's
  // agents explicitly first, then the workspace (which cascades its members/
  // flows rows).
  await runQuery(`DELETE FROM agents WHERE workspace_id = ANY($1::uuid[])`, [
    seededWorkspaceIds,
  ])
  await runQuery(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [seededWorkspaceIds])
  seededWorkspaceIds = []
}

interface SeedAgentOpts {
  name?: string
  kind?: string
  roles?: string[]
  instructions?: string
  skills?: string[]
  visibility?: string
  concurrency?: number
  model?: string
  runtime?: string
  ownerId?: string
  status?: string
  availability?: string
  activity?: Array<{ total: number; ok?: number; fail: number }>
  summary?: string
  inputSchema?: string
  outputSchema?: string
  /** When set, a workspace_members row is seeded so `owner` resolves to it. */
  ownerDisplayName?: string
}

/** Insert a workspace + an agent row, returning both ids for cleanup/assertion. */
async function seedAgent(opts: SeedAgentOpts = {}): Promise<{ workspaceId: string; agentId: string }> {
  const workspaceId = randomUUID()
  await runQuery(
    `INSERT INTO workspaces (id, name, description, owner_user_id, status, quota, glyph)
     VALUES ($1, $2, NULL, NULL, 'active', '{}'::jsonb, 'W')`,
    [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
  )
  seededWorkspaceIds.push(workspaceId)

  if (opts.ownerDisplayName && opts.ownerId) {
    await runQuery(
      `INSERT INTO workspace_members (workspace_id, member_id, display_name, initial, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [workspaceId, opts.ownerId, opts.ownerDisplayName, opts.ownerDisplayName!.slice(0, 1)],
    )
  }

  const agentId = randomUUID()
  await runQuery(
    `INSERT INTO agents (id, workspace_id, name, kind, roles, instructions, skills,
                         visibility, concurrency, model, runtime, owner_id,
                         status, availability, activity,
                         summary, input_schema, output_schema)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb,
             $8, $9, $10, $11, $12,
             $13, $14, $15::jsonb,
             $16, $17, $18)`,
    [
      agentId,
      workspaceId,
      opts.name ?? '论文阅读 · reader-04',
      opts.kind ?? 'claude',
      JSON.stringify(opts.roles ?? ['reader', 'analysis']),
      opts.instructions ?? '你是一名资深科研阅读 agent。',
      JSON.stringify(opts.skills ?? ['arxiv-parse', 'pdf-extract']),
      opts.visibility ?? 'workspace',
      opts.concurrency ?? 4,
      opts.model ?? 'claude-sonnet-4',
      opts.runtime ?? 'claude-code · daemon-09',
      opts.ownerId ?? '林敏',
      opts.status ?? 'running',
      opts.availability ?? 'online',
      JSON.stringify(opts.activity ?? [{ total: 3, fail: 0 }]),
      opts.summary ?? '阅读论文并抽取核心论点、方法、可复现实验清单。',
      opts.inputSchema ?? '{pdf_uri, focus?}',
      opts.outputSchema ?? '{summary, claims[], refs[]}',
    ],
  )
  return { workspaceId, agentId }
}

/** The design field set the M9.1 acceptance requires (agents-data.js:22-40). */
const DESIGN_FIELDS = [
  'id', 'name', 'kind', 'roles', 'instructions', 'skills', 'visibility',
  'concurrency', 'model', 'runtime', 'owner', 'activity', 'status',
  'availability', 'summary',
  // design's run-context + derived fields (present so the shape matches 1:1)
  'region', 'daemon', 'run', 'flow', 'load', 'cost', 'progress', 'elapsed',
  'inputSchema', 'outputSchema', 'created', 'lastActiveDays', 'runCount',
  'failCount',
] as const

describe('GET /api/v1/agents/:id — design-aligned shape (M9.1 acceptance)', () => {
  it('returns every design field with summary/activity/owner top-level', async () => {
    const { agentId } = await seedAgent()

    const res = await app.request(`/api/v1/agents/${agentId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { agent: Record<string, unknown> } }
    expect(body.success).toBe(true)

    const agent = body.data.agent
    // The M9.1 acceptance bar: every design field is present.
    for (const field of DESIGN_FIELDS) {
      expect(agent).toHaveProperty(field)
    }

    // Naming alignment: summary / activity / owner are top-level (not nested
    // under a capability sub-object, not owner_id).
    expect(typeof agent.summary).toBe('string')
    expect(agent.summary).toBe('阅读论文并抽取核心论点、方法、可复现实验清单。')
    expect(Array.isArray(agent.activity)).toBe(true)
    expect(typeof agent.owner).toBe('string')
    expect(agent.owner).toBe('林敏') // raw owner_id fallback (no member row)

    // Enum values align with the design's unions.
    expect(agent.kind).toBe('claude')
    expect(agent.status).toBe('running')
    expect(agent.availability).toBe('online')
    expect(agent.visibility).toBe('workspace')

    // Typed fields from the design.
    expect(agent.concurrency).toBe(4)
    expect(agent.model).toBe('claude-sonnet-4')
    expect(agent.runtime).toBe('claude-code · daemon-09')
    expect(Array.isArray(agent.roles)).toBe(true)
    expect(agent.roles).toEqual(['reader', 'analysis'])
    expect(Array.isArray(agent.skills)).toBe(true)
    expect(agent.skills).toEqual(['arxiv-parse', 'pdf-extract'])
    expect(typeof agent.instructions).toBe('string')
    expect(agent.instructions).toBe('你是一名资深科研阅读 agent。')
    expect(typeof agent.inputSchema).toBe('string')
    expect(typeof agent.outputSchema).toBe('string')
    expect(typeof agent.created).toBe('string') // ISO string
  })

  it('coerces activity buckets to {total,ok,fail} (ok derived = total - fail)', async () => {
    const { agentId } = await seedAgent({
      activity: [
        { total: 5, fail: 1 },
        { total: 3, ok: 2, fail: 1 },
      ],
    })

    const res = await app.request(`/api/v1/agents/${agentId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { agent: { activity: Array<{ total: number; ok: number; fail: number }> } } }
    const activity = body.data.agent.activity

    expect(activity).toHaveLength(2)
    // bucket without `ok` → derived as total - fail
    expect(activity[0]).toEqual({ total: 5, ok: 4, fail: 1 })
    // bucket with explicit `ok` → preserved
    expect(activity[1]).toEqual({ total: 3, ok: 2, fail: 1 })
  })

  it('stamps runCount/failCount from activity (design agents-data.js:228-231)', async () => {
    const { agentId } = await seedAgent({
      activity: [
        { total: 5, fail: 1 },
        { total: 3, fail: 1 },
        { total: 2, fail: 0 },
      ],
    })

    const res = await app.request(`/api/v1/agents/${agentId}`)
    const body = (await res.json()) as { data: { agent: { runCount: number; failCount: number } } }
    expect(body.data.agent.runCount).toBe(10) // 5 + 3 + 2
    expect(body.data.agent.failCount).toBe(2) // 1 + 1 + 0
  })

  it('resolves owner to the member display_name when an owner member exists', async () => {
    const { agentId } = await seedAgent({
      ownerId: 'u1',
      ownerDisplayName: '林敏',
    })

    const res = await app.request(`/api/v1/agents/${agentId}`)
    const body = (await res.json()) as { data: { agent: { owner: string } } }
    expect(body.data.agent.owner).toBe('林敏') // display_name, not the raw 'u1'
  })

  it('400s on a malformed agent id', async () => {
    const res = await app.request('/api/v1/agents/not-a-uuid')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('invalid agent id')
  })

  it('404s when no agent matches the id', async () => {
    const res = await app.request(`/api/v1/agents/00000000-0000-4000-8000-000000000000`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('agent not found')
  })
})

describe('GET /api/v1/agents — list (design-aligned shape)', () => {
  it('lists design-shaped agents + a truncated flag', async () => {
    const { agentId } = await seedAgent({ name: 'list-agent' })

    const res = await app.request('/api/v1/agents')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { agents: Record<string, unknown>[]; truncated: boolean }
    }
    expect(body.success).toBe(true)
    expect(typeof body.data.truncated).toBe('boolean')

    const seeded = body.data.agents.find((a) => a.id === agentId)
    expect(seeded).toBeDefined()
    // The list emits the same design shape as the detail route.
    for (const field of DESIGN_FIELDS) {
      expect(seeded).toHaveProperty(field)
    }
    expect(seeded!.summary).toBe('阅读论文并抽取核心论点、方法、可复现实验清单。')
    expect(seeded!.owner).toBe('林敏')
  })
})
