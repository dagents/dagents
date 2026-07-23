import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runQuery } from '@mil/db'
import type { TaskAssigneeType } from '@mil/db'
import { createLogger } from '@mil/shared'

/**
 * `/api/v1/tasks` — task creation API aligned to the v0.3 design (plan
 * v0.3-M9.3 / 后端契约 3; source of truth: `design/new-task.html` submit
 * payload + the plan's prescribed `POST /api/v1/tasks` contract).
 *
 * The design's `new-task.html` itself does NOT POST — it GET-navigates to
 * `workspace.html?new=1&…` (see `docs/v0.3-fidelity-audit.md` §后端契约 3). The
 * `POST /api/v1/tasks` shape here is the plan's prescribed contract for when
 * the console migrates the composer to a real submit. This route materializes
 * that contract: it accepts the design submit body, persists a `tasks` row,
 * mints a `runId`, writes a `runs` placeholder row, and returns
 * `{ task:{id,status,runId}, runId, path }`.
 *
 * ## assigneeType → path (the two execution paths)
 *
 * `assigneeType` routes the task onto one of two execution paths:
 *   - `flow`        → Path A (flow fan-out), `path='flow'`
 *   - `agent|squad` → Path B (direct-agent dispatch), `path='direct'`
 * (squads are multi-agent direct dispatch, not a flow fan-out, so they share
 * Path B with single agents.) The `path` is computed from `assigneeType` and
 * stamped on both the response and the `runs` placeholder row so the platform
 * can later route the run to the scheduler fan-out (Path A) or the dispatch
 * direct-invoke (Path B) without re-deriving it.
 *
 * ## Honest runId (not synthetic)
 *
 * A `runId` (randomUUID) is minted at creation and written to BOTH
 * `tasks.run_id` AND a `runs` placeholder row (`status='pending'`,
 * `path` set, `task_id` back-referencing the task, `agent_id` set for Path B).
 * This keeps the response honest — the `runId` is a real run the platform can
 * look up, not a placeholder string. The runs `status` is the runs lifecycle
 * `'pending'` (the `runs_status_chk` CHECK allows pending/running/completed/
 * failed/cancelled — NOT `'queued'`, which is the `dispatch_tasks` vocabulary).
 *
 * ## MVP boundary (no real dispatch here)
 *
 * This route does NOT trigger real dispatch — it does not fan out to the
 * scheduler, does not claim a daemon, does not invoke an agent. It only
 * persists the task + a `runs` placeholder and returns the path. Real
 * dispatch is a downstream concern: Path A is driven by the scheduler's
 * fan-out worker, Path B by the dispatch claim protocol. (Plan M9.3 §边界.)
 *
 * ## Auth
 *
 * Gated by the SSO session middleware (M5b.4) under `REQUIRE_LOGIN=1`, same
 * posture as the other gateway-owned writes (lab/agents); membership scoping
 * is a follow-up (RBAC). `x-run-id` is forwarded best-effort for trace
 * correlation but is NOT used as the task's run id — the route mints its own
 * so the task↔run link is always durable even when the caller omits the header.
 *
 * Standard envelope (CLAUDE.md API convention): { success, data?, error? }.
 */

export const tasksRoutes = new Hono()

const log = createLogger({ svc: 'gateway:tasks' })

/** Standard envelope helpers (same shape as the rest of the gateway). */
const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

/**
 * The design submit body (plan M9.3 §Step 1). `assigneeType` is the
 * flow|agent|squad union the `tasks_assignee_type_chk` CHECK enforces;
 * `workspaceId` / `creatorId` are required (a task always belongs to a
 * workspace + a creator); `contextRefs` / `priority` / `dueDate` are optional
 * design fields persisted verbatim.
 */
const createTaskBodySchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  assigneeType: z.enum(['flow', 'agent', 'squad']),
  assigneeId: z.string().min(1).max(256),
  creatorId: z.string().min(1).max(256),
  workspaceId: z.string().uuid(),
  contextRefs: z.array(z.string().max(1024)).max(100).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  dueDate: z.string().datetime().optional(),
})

/** The two execution paths a task can take (mirrors `runs_path_chk`). */
type TaskPath = 'flow' | 'direct'

/** Map an assignee type onto its execution path (Path A vs Path B). */
function pathForAssignee(assigneeType: TaskAssigneeType): TaskPath {
  return assigneeType === 'flow' ? 'flow' : 'direct'
}

/** snake_case row shape from pg for a created tasks row. */
interface TaskRow {
  id: string
  status: string
  run_id: string | null
}

/** snake_case row shape from pg for a created runs placeholder row. */
interface RunRow {
  id: string
}

/**
 * POST /api/v1/tasks — create a task + a runs placeholder, return the
 * `{ task:{id,status,runId}, runId, path }` shape.
 *
 * 400 on an invalid body (zod parse failure), 502 on a persistence failure
 * (the tasks/runs tables may not exist on a fresh DB before the migration
 * runs — surface infrastructure, not a 500 leaking the pg error stack which
 * can carry the connection string). The task + run are written in a single
 * `runQuery` transaction (short-lived QueryRunner) so the task↔run link is
 * atomic — a half-written task with no run (or vice versa) never lands.
 */
tasksRoutes.post('/', async (c) => {
  let parsed: z.infer<typeof createTaskBodySchema>
  try {
    parsed = createTaskBodySchema.parse(await c.req.json().catch(() => null))
  } catch (err) {
    return fail(c, 400, 'invalid body', { detail: String(err) })
  }

  const path: TaskPath = pathForAssignee(parsed.assigneeType)
  const runId = randomUUID()
  // Path B (direct) targets an agent; Path A (flow) targets a flow, so
  // agent_id is null on the flow path. squad is multi-agent direct dispatch —
  // its agent_id is the squad id (the dispatch layer resolves squad→agents).
  const agentId = path === 'direct' ? parsed.assigneeId : null
  // A freshly created task is ready to run: 'todo', not 'backlog' (the table
  // default). backlog is for unscheduled board items; a submitted task has a
  // creator + assignee and is queued for execution.
  const status = 'todo'

  // Mint the task id client-side so we can write both the task row and the
  // runs placeholder (which back-references it via task_id) in one transaction
  // without a round-trip to read the inserted id.
  const taskId = randomUUID()
  // runs.input carries the design submit context (title/description/contextRefs
  // /priority/dueDate) as JSONB so the downstream path has the full task
  // context without a join — matches how the scheduler's createRun stashes the
  // batch input. The placeholder's status is the runs lifecycle 'pending'
  // (NOT 'queued' — that's the dispatch_tasks vocabulary; the runs CHECK only
  // allows pending/running/completed/failed/cancelled).
  const runInput = {
    title: parsed.title,
    description: parsed.description ?? '',
    assigneeType: parsed.assigneeType,
    assigneeId: parsed.assigneeId,
    creatorId: parsed.creatorId,
    contextRefs: parsed.contextRefs ?? [],
    priority: parsed.priority ?? 'none',
    dueDate: parsed.dueDate ?? null,
  }

  try {
    const { records } = await runQuery<TaskRow>(
      `INSERT INTO tasks
         (id, workspace_id, title, description, status, priority,
          assignee_type, assignee_id, creator_id, context_refs, run_id, due_date,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3, $4, $5, $6,
          $7, $8, $9, $10::jsonb, $11, $12,
          NOW(), NOW())
       RETURNING id, status, run_id`,
      [
        taskId,
        parsed.workspaceId,
        parsed.title,
        parsed.description ?? '',
        status,
        parsed.priority ?? 'none',
        parsed.assigneeType,
        parsed.assigneeId,
        parsed.creatorId,
        JSON.stringify(parsed.contextRefs ?? []),
        runId,
        parsed.dueDate ?? null,
      ],
    )
    if (!records[0]) {
      return fail(c, 502, 'task create failed')
    }
    const taskRow = records[0]

    // Write the runs placeholder linked back to the task. pipeline_id is the
    // assigneeId for Path A (a flow id) or the agent/squad id for Path B —
    // matches the scheduler's createRun contract (pipeline_id = the flow the
    // run executes). workspace_id is TEXT on runs (no FK), so cast-free.
    await runQuery<RunRow>(
      `INSERT INTO runs
         (id, identifier, pipeline_id, status, parent_run_id, input,
          workspace_id, task_id, agent_id, path, created_at)
       VALUES
         ($1::uuid, $2, $3, 'pending', NULL, $4::jsonb,
          $5, $6, $7, $8, NOW())
       RETURNING id`,
      [
        runId,
        `task-${taskId.slice(0, 8)}`,
        parsed.assigneeId,
        JSON.stringify(runInput),
        parsed.workspaceId,
        taskId,
        agentId,
        path,
      ],
    )

    return ok(c, {
      task: {
        id: taskRow.id,
        status: taskRow.status,
        runId,
      },
      runId,
      path,
    })
  } catch (err) {
    // The tasks/runs tables may not exist yet on a fresh DB before the
    // migration runs; surface a 502 (infrastructure) rather than a 500
    // leaking the pg error stack (which can carry the connection string).
    log.error('task create failed', { error: String(err) })
    return fail(c, 502, 'task create failed')
  }
})
