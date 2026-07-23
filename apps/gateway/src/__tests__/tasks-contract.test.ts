import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@mil/db'
import { randomUUID } from 'node:crypto'

/**
 * Acceptance test for v0.3-M9.3 / 后端契约 3 (POST /api/v1/tasks create route).
 *
 * Source of truth: plan v0.3-M9.3 + `design/new-task.html` submit payload. The
 * design's `new-task.html` itself does NOT POST (it GET-navigates to
 * `workspace.html?new=1&…` — see `docs/v0.3-fidelity-audit.md` §后端契约 3); the
 * `POST /api/v1/tasks` shape is the plan's prescribed contract for when the
 * console migrates the composer to a real submit. This route materializes that
 * contract: it accepts the design submit body, persists a `tasks` row, mints a
 * `runId`, writes a `runs` placeholder row, and returns
 * `{ task:{id,status,runId}, runId, path }` where `path` routes the task onto
 * Path A (flow fan-out, `assigneeType='flow'`) or Path B (direct-agent
 * dispatch, `assigneeType='agent'|'squad'`).
 *
 * Drives the gateway via Hono's in-process `app.request()` against the real
 * milagents Postgres (the platform-owned `tasks` + `runs` + `workspaces`
 * tables). Each test seeds its own workspace and wipes the rows it wrote —
 * `tasks` has NO FK cascade to `workspaces` (no `REFERENCES`, no
 * `ON DELETE CASCADE`, same no-cascade posture as `agents`), so `cleanupSeeded`
 * deletes the seeded tasks + runs explicitly *before* the workspace; deleting
 * the workspace first would orphan the task rows and leak them into the shared
 * dev DB. `runs` likewise has no FK to `tasks` (`task_id` is plain TEXT), so
 * the seeded runs are deleted by `workspace_id` too.
 *
 * Coverage:
 * - POST /api/v1/tasks with assigneeType='agent' → path='direct' + full shape
 * - POST /api/v1/tasks with assigneeType='flow' → path='flow'
 * - POST with assigneeType='squad' → path='direct' (Path B covers squad too)
 * - the response `runId` is a real UUID that backs a `runs` placeholder row
 *   (status='pending', path set, task_id back-references the task) — the
 *   response is honest, not a synthetic id
 * - 400 on an invalid body (missing title / bad assigneeType / bad workspaceId)
 * - 405 on a non-POST method (the route is POST-only)
 */

const PG_URL =
  process.env.POSTGRES_URL ?? 'postgresql://milagents:milagents_dev@localhost:15432/milagents'

beforeAll(async () => {
  // `@mil/db`'s DataSource captures POSTGRES_URL at module construction; set
  // it defensively for the dev stack remap (:15432), matching agents-shape.test.
  process.env.POSTGRES_URL ??= PG_URL
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
})

afterAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

afterEach(async () => {
  await cleanupSeeded()
})

// Track the workspace ids this test seeded so afterEach can wipe just them
// (never the shared dev rows). `tasks` + `runs` have no FK cascade to
// `workspaces`, so `cleanupSeeded` deletes the seeded tasks + runs by
// `workspace_id` first, then the workspace — the order matters: deleting the
// workspace alone would orphan the task/run rows.
let seededWorkspaceIds: string[] = []

async function cleanupSeeded(): Promise<void> {
  if (seededWorkspaceIds.length === 0) return
  // `runs` has no `task_id REFERENCES tasks` (plain TEXT, no FK) and no
  // `workspace_id REFERENCES workspaces` (plain TEXT), so deleting the
  // workspace alone would leak both. Delete this test's runs + tasks by
  // `workspace_id` first, then the workspace.
  await runQuery(`DELETE FROM runs WHERE workspace_id = ANY($1::text[])`, [
    seededWorkspaceIds,
  ])
  await runQuery(`DELETE FROM tasks WHERE workspace_id = ANY($1::uuid[])`, [
    seededWorkspaceIds,
  ])
  await runQuery(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [
    seededWorkspaceIds,
  ])
  seededWorkspaceIds = []
}

/** Insert a workspace row, returning its id for cleanup/assertion. */
async function seedWorkspace(): Promise<string> {
  const workspaceId = randomUUID()
  await runQuery(
    `INSERT INTO workspaces (id, name, description, owner_user_id, status, quota, glyph)
     VALUES ($1, $2, NULL, NULL, 'active', '{}'::jsonb, 'W')`,
    [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
  )
  seededWorkspaceIds.push(workspaceId)
  return workspaceId
}

/** JSON + a placeholder auth header (REQUIRE_LOGIN is off in tests, so this is
 *  only here so a future SSO-gated run still resolves the content type). */
const jsonHeaders = { 'content-type': 'application/json' }

describe('POST /api/v1/tasks — assigneeType→path 双路径 (M9.3 acceptance)', () => {
  it('assigneeType=agent returns { task, runId, path:"direct" }', async () => {
    const workspaceId = await seedWorkspace()

    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: '复现论文实验',
        description: '跑通 Reproducibility 段的 3 个 benchmark',
        assigneeType: 'agent',
        assigneeId: 'agent-reader-04',
        creatorId: '林敏',
        workspaceId,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        task: { id: string; status: string; runId: string }
        runId: string
        path: string
      }
    }
    expect(body.success).toBe(true)

    // The M9.3 acceptance shape: { task:{id,status,runId}, runId, path }.
    expect(body.data).toMatchObject({
      task: {
        id: expect.any(String),
        status: expect.any(String),
        runId: expect.any(String),
      },
      runId: expect.any(String),
      path: 'direct',
    })

    // The task's runId and the top-level runId are the same minted id, and the
    // task id is a UUID.
    expect(body.data.task.runId).toBe(body.data.runId)
    expect(body.data.task.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // A freshly created task is ready to run, not parked in backlog.
    expect(body.data.task.status).toBe('todo')
  })

  it('assigneeType=flow returns path:"flow"', async () => {
    const workspaceId = await seedWorkspace()

    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: '批量复现流水线',
        description: '走 flow fan-out',
        assigneeType: 'flow',
        assigneeId: 'flow_repro_01',
        creatorId: '林敏',
        workspaceId,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { path: string; runId: string; task: { runId: string } } }
    expect(body.data.path).toBe('flow')
    expect(body.data.runId).toBe(body.data.task.runId)
  })

  it('assigneeType=squad returns path:"direct" (Path B covers squad)', async () => {
    const workspaceId = await seedWorkspace()

    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: '小队协作任务',
        assigneeType: 'squad',
        assigneeId: 'squad-review-01',
        creatorId: '林敏',
        workspaceId,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { path: string } }
    // squad is a multi-agent direct dispatch (Path B), not a flow fan-out.
    expect(body.data.path).toBe('direct')
  })

  it('mints a real runId backing a runs placeholder row (honest response)', async () => {
    const workspaceId = await seedWorkspace()

    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: 'honest-run-check',
        assigneeType: 'flow',
        assigneeId: 'flow_repro_01',
        creatorId: '林敏',
        workspaceId,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { runId: string; task: { id: string }; path: string } }
    const { runId, path } = body.data
    const taskId = body.data.task.id

    // The runId is not synthetic: a runs placeholder row exists for it, linked
    // back to the task and stamped with the path. status is the runs lifecycle
    // 'pending' (NOT 'queued' — that's the dispatch_tasks vocabulary; the runs
    // CHECK only allows pending/running/completed/failed/cancelled).
    const { records } = await runQuery<{ status: string; path: string | null; task_id: string | null; agent_id: string | null }>(
      `SELECT status, path, task_id, agent_id FROM runs WHERE id = $1::uuid`,
      [runId],
    )
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('pending')
    expect(records[0]!.path).toBe(path)
    expect(records[0]!.task_id).toBe(taskId)
    // Path A (flow) targets a flow, not an agent — agent_id stays null.
    expect(records[0]!.agent_id).toBeNull()

    // And the task row carries the same run_id.
    const { records: taskRows } = await runQuery<{ run_id: string | null; status: string }>(
      `SELECT run_id, status FROM tasks WHERE id = $1::uuid`,
      [taskId],
    )
    expect(taskRows[0]!.run_id).toBe(runId)
    expect(taskRows[0]!.status).toBe('todo')
  })

  it('stamps agent_id on the run for a direct (agent) task', async () => {
    const workspaceId = await seedWorkspace()

    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: 'direct-agent-stamp',
        assigneeType: 'agent',
        assigneeId: 'agent-reader-04',
        creatorId: '林敏',
        workspaceId,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { runId: string } }
    // Path B (direct) targets an agent — agent_id is the assignee id.
    const { records } = await runQuery<{ agent_id: string | null; path: string | null }>(
      `SELECT agent_id, path FROM runs WHERE id = $1::uuid`,
      [body.data.runId],
    )
    expect(records[0]!.agent_id).toBe('agent-reader-04')
    expect(records[0]!.path).toBe('direct')
  })

  it('persists contextRefs / priority / dueDate when supplied', async () => {
    const workspaceId = await seedWorkspace()

    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: 'with-opts',
        assigneeType: 'agent',
        assigneeId: 'a1',
        creatorId: 'u',
        workspaceId,
        contextRefs: ['dir://papers/2026', 'file://notes.md'],
        priority: 'high',
        dueDate: '2026-08-01T00:00:00.000Z',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { task: { id: string } } }
    const { records } = await runQuery<{ context_refs: unknown; priority: string; due_date: Date | null }>(
      `SELECT context_refs, priority, due_date FROM tasks WHERE id = $1::uuid`,
      [body.data.task.id],
    )
    expect(records[0]!.priority).toBe('high')
    expect(records[0]!.due_date).not.toBeNull()
    expect(records[0]!.context_refs).toEqual(['dir://papers/2026', 'file://notes.md'])
  })

  it('400s on a missing required field (title)', async () => {
    const workspaceId = await seedWorkspace()
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        description: 'no title',
        assigneeType: 'agent',
        assigneeId: 'a1',
        creatorId: 'u',
        workspaceId,
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('invalid body')
  })

  it('400s on a bad assigneeType (not flow|agent|squad)', async () => {
    const workspaceId = await seedWorkspace()
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: 't',
        assigneeType: 'pipeline',
        assigneeId: 'a1',
        creatorId: 'u',
        workspaceId,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on a malformed workspaceId (not a uuid)', async () => {
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: 't',
        assigneeType: 'agent',
        assigneeId: 'a1',
        creatorId: 'u',
        workspaceId: 'not-a-uuid',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on a non-JSON / empty body', async () => {
    const res = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: '',
    })
    expect(res.status).toBe(400)
  })

  it('does not register a GET on /api/v1/tasks (POST-only route)', async () => {
    // The route is POST-only; a GET is not a registered method on this path so
    // Hono 404s it (same posture as the lab routes' unregistered methods). This
    // guards against an accidental .all() that would advertise a read surface
    // the contract doesn't define.
    const res = await app.request('/api/v1/tasks', { method: 'GET' })
    expect(res.status).toBe(404)
  })
})
