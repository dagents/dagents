import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Drop orphaned tables whose routes + entities were removed in the chat-first
 * redesign (spec §2.5 + §6.2).
 *
 * After commit `9c99927` (chore: 清理已弃用的 gateway 路由与实体) the gateway
 * no longer mounts `/api/v1/lab` or `/api/v1/tasks`, the @mil/db package no
 * longer exports the `LabSession` / `LabMessage` / `Task` entities, and no
 * production code references these tables. The tables themselves still exist
 * in the DB (CREATE TABLE migrations `1720000006000` + `1720000008002` ran
 * before the cleanup), so this migration drops them to close the loop.
 *
 * NOT dropped here (still referenced by production code):
 *   - `workspaces` / `workspace_members` / `workspace_flows` — `agents.ts`
 *     still JOINs `workspace_members` to resolve owner display names, and the
 *     `agents` table has a NOT NULL `workspace_id` column. Migrating the
 *     agents module off workspaces is a separate task.
 *   - `runs.workspace_id` / `runs.task_id` / `runs.agent_id` / `runs.path` —
 *     the `Run` entity still exposes `workspaceId`, and `scheduler/reproduce.ts`
 *     reads it. Dropping these columns needs the entity + callers updated first.
 */
export class DropOrphanedTables1720000010000 implements MigrationInterface {
  name = 'DropOrphanedTables1720000010000'

  async up(qr: QueryRunner): Promise<void> {
    // lab_messages has a FK → lab_sessions ON DELETE CASCADE, but DROP TABLE
    // IF EXISTS ordered children-first keeps the migration a no-op on a DB
    // where lab_sessions was already dropped (and silences the FK violation
    // if CASCADE wasn't applied).
    await qr.query(`DROP TABLE IF EXISTS "lab_messages"`)
    await qr.query(`DROP TABLE IF EXISTS "lab_sessions"`)
    await qr.query(`DROP TABLE IF EXISTS "tasks"`)
  }

  async down(qr: QueryRunner): Promise<void> {
    // Recreate the tables with the same shape as their original create
    // migrations (1720000006000 + 1720000008002). Idempotent guards mirror the
    // originals so re-running on a partially-dropped DB is safe.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "lab_sessions" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          TEXT NOT NULL,
        "description"   TEXT,
        "status"        TEXT NOT NULL DEFAULT 'running',
        "workspace_id"  UUID,
        "mode"          TEXT NOT NULL DEFAULT 'auto',
        "agents_count"  INTEGER NOT NULL DEFAULT 0,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT lab_sessions_status_chk
          CHECK ("status" IN ('running','paused','done')),
        CONSTRAINT lab_sessions_mode_chk
          CHECK ("mode" IN ('auto','assist'))
      )
    `)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_lab_sessions_workspace ON "lab_sessions" ("workspace_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_lab_sessions_status ON "lab_sessions" ("status")`)

    await qr.query(`
      CREATE TABLE IF NOT EXISTS "lab_messages" (
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
      )
    `)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_lab_messages_session ON "lab_messages" ("session_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_lab_messages_parent ON "lab_messages" ("parent_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_lab_messages_run_id ON "lab_messages" ("run_id")`)

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
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON "tasks" ("parent_task_id")`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_tasks_run ON "tasks" ("run_id")`)
  }
}
