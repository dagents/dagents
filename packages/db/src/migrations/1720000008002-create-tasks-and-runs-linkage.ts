import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * v0.3-M9.3 — platform-owned `tasks` table + `runs` execution-linkage columns.
 *
 * The gateway's new `POST /api/v1/tasks` route (plan v0.3-M9.3) materializes
 * the design's `new-task.html` submit payload as a durable row: one task per
 * submission carrying `assigneeType` (`flow` | `agent` | `squad`) +
 * `assigneeId` + the design's `title` / `description` / `contextRefs` /
 * `priority` / `dueDate`. It also mints a `runId` per submission and writes a
 * `runs` placeholder row so the response shape `{ task:{id,status,runId},
 * runId, path }` is honest — `path` (`flow` | `direct`) routes the task to the
 * flow fan-out path (Path A) or the direct-agent dispatch path (Path B).
 *
 * ## Why this migration exists now
 *
 * The `tasks` table and the three `runs` linkage columns (`task_id` /
 * `agent_id` / `path`) already exist on the deployed dev DB — they were
 * created by an out-of-repo migration (the live `public.tasks` /
 * `public.runs` catalog was inspected to reconstruct this DDL). As with the
 * `agents` create-table migration (`1720000008000`), the DDL was never in
 * git, so a fresh DB (CI, a new dev machine, a container recreated from
 * scratch) could not rebuild the schema from the repo alone — a fresh DB has
 * no `tasks` table, so `POST /api/v1/tasks` 502'd before this task even ran
 * its acceptance test. This migration brings the create-table DDL + the
 * `runs` ALTER in-repo so the migration set is self-contained and a fresh DB
 * is rebuildable end-to-end.
 *
 * The DDL mirrors the deployed dev schema 1:1 (columns, defaults, CHECK
 * constraints, indexes) — reconstructed from the live catalog so a fresh DB
 * matches what the dev stack runs. Column order, types, defaults, CHECK
 * enumerations, and index names are all byte-identical to dev.
 *
 * ## Idempotence
 *
 * Every statement is guarded (`CREATE TABLE IF NOT EXISTS` /
 * `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`): the dev DB
 * already has this schema, so re-running here is a safe no-op rather than a
 * hard `relation already exists` error. On a fresh DB the guards pass through
 * and create everything.
 *
 * ## No FK cascade to `workspaces` (mirrors `agents`)
 *
 * `tasks.workspace_id` is a plain NOT NULL UUID with an index (no `REFERENCES
 * workspaces` / `ON DELETE CASCADE`) — the same no-cascade posture the
 * `agents` table takes (see `CreateDomainTables1720000008000`'s rationale).
 * Cleaning up a task row when its workspace is deleted is the application's
 * responsibility, not the DB's. A structural FK can be added in a later task
 * if the no-cascade posture is ever reconsidered; this migration reproduces
 * the deployed schema as-is.
 *
 * ## runs linkage columns
 *
 * The three nullable `runs` columns (`task_id`, `agent_id`, `path`) tie a run
 * row back to the task that spawned it + the agent (or flow) it targeted +
 * which of the two execution paths it took. `path` is CHECK-constrained to
 * `flow` | `direct` (NULL until a task creates the run). These pre-exist on
 * dev; `ADD COLUMN IF NOT EXISTS` keeps the migration a no-op there.
 *
 * Indexes (mirror dev):
 *   - tasks (workspace_id, status)   the workspace task board filter
 *   - tasks (assignee_type, assignee_id)   "tasks for this agent/flow/squad"
 *   - tasks (parent_task_id)         parent↔child task tree
 *   - tasks (run_id)                 run→task back-reference lookup
 *   - runs (task_id)                 the reverse: task→runs lookup
 *   - runs (agent_id)                agent-scoped run history
 *   - runs (path)                    the Path A / Path B split
 *
 * CHECK constraints (mirror dev):
 *   - tasks_assignee_type_chk  assignee_type IN ('flow','agent','squad')
 *   - tasks_status_chk         status IN ('backlog','todo','in_progress',
 *                              'in_review','done','blocked','cancelled')
 *   - tasks_priority_chk       priority IN ('urgent','high','medium','low',
 *                              'none')
 *   - runs_path_chk            path IS NULL OR path IN ('flow','direct')
 */
export class CreateTasksAndRunsLinkage1720000008002 implements MigrationInterface {
  name = 'CreateTasksAndRunsLinkage1720000008002'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "tasks" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspace_id"   UUID NOT NULL,
        "title"          TEXT NOT NULL,
        "description"    TEXT NOT NULL DEFAULT ''::text,
        "status"         TEXT NOT NULL DEFAULT 'backlog'::text,
        "priority"       TEXT NOT NULL DEFAULT 'none'::text,
        "assignee_type"  TEXT NOT NULL,
        "assignee_id"    TEXT NOT NULL,
        "creator_id"     TEXT NOT NULL,
        "parent_task_id" UUID,
        "context_refs"   JSONB NOT NULL DEFAULT '[]'::jsonb,
        "position"       NUMERIC NOT NULL DEFAULT 0,
        "run_id"         TEXT,
        "due_date"       TIMESTAMPTZ,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tasks_assignee_type_chk
          CHECK ("assignee_type" IN ('flow','agent','squad')),
        CONSTRAINT tasks_status_chk
          CHECK ("status" IN ('backlog','todo','in_progress','in_review','done','blocked','cancelled')),
        CONSTRAINT tasks_priority_chk
          CHECK ("priority" IN ('urgent','high','medium','low','none'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON "tasks" ("workspace_id", "status")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON "tasks" ("assignee_type", "assignee_id")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON "tasks" ("parent_task_id")`,
    )
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_tasks_run ON "tasks" ("run_id")`)

    // The three runs linkage columns pre-exist on dev; the guards make this a
    // no-op there and a real ALTER on a fresh DB.
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "task_id" TEXT`)
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "agent_id" TEXT`)
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "path" TEXT`)
    await qr.query(
      `ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_path_chk`,
    )
    await qr.query(
      `ALTER TABLE "runs" ADD CONSTRAINT runs_path_chk CHECK ("path" IS NULL OR ("path" IN ('flow','direct')))`,
    )
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_runs_task ON "runs" ("task_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_runs_agent ON "runs" ("agent_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_runs_path ON "runs" ("path")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_runs_path`)
    await qr.query(`DROP INDEX IF EXISTS idx_runs_agent`)
    await qr.query(`DROP INDEX IF EXISTS idx_runs_task`)
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_path_chk`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "path"`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "agent_id"`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "task_id"`)
    await qr.query(`DROP TABLE IF EXISTS "tasks"`)
  }
}
