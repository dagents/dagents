import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M2.2 — central dispatch protocol tables (spec §5.3).
 *
 * Creates the four tables the dispatch server's pull-based protocol needs:
 *   - daemons            daemon instances (register / heartbeat / claim owner)
 *   - agent_daemons      which agent kind a daemon serves (invoke target)
 *   - dispatch_tasks     the work queue (queued → claimed → running → done)
 *   - dispatch_task_events  streamed messages/progress per task
 *
 * P1.2.T2/T3 call for TypeORM entities + migrations for these tables; those
 * entity classes are not yet on `main`. This migration materialises the schema
 * now (M2.2's endpoints cannot run without it) using raw SQL 1:1 with §5.3 so
 * a later P1.2 entity pass can adopt the same columns without a rewrite. The
 * dispatch routes query these tables with parameterised raw SQL — no entity
 * class is loaded at runtime, so there is no decorator/dist-resolution gap.
 *
 * Indexes follow §5.3's notes: (status, agent_daemon_id) for claim selects,
 * (run_id) for run-scoped lookups, (task_id, seq) for ordered event reads.
 */
export class CreateDispatchTables1720000000000 implements MigrationInterface {
  name = 'CreateDispatchTables1720000000000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "daemons" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "label"             TEXT NOT NULL,
        "endpoint"          TEXT,
        "status"            TEXT NOT NULL DEFAULT 'online',
        "last_heartbeat_at" TIMESTAMPTZ,
        "capabilities"      JSONB NOT NULL DEFAULT '[]'::jsonb,
        "workspace_id"      UUID,
        "token"             TEXT NOT NULL,
        "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT daemons_status_chk CHECK ("status" IN ('online','offline','draining'))
      )
    `)

    await qr.query(`
      CREATE TABLE "agent_daemons" (
        "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"                  TEXT NOT NULL,
        "kind"                  TEXT NOT NULL,
        "daemon_id"             UUID NOT NULL REFERENCES "daemons"("id") ON DELETE CASCADE,
        "capability_descriptor" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "executable_path"       TEXT,
        "default_args"          JSONB NOT NULL DEFAULT '[]'::jsonb,
        "workspace_id"          UUID,
        "visibility"            TEXT,
        "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await qr.query(`
      CREATE TABLE "dispatch_tasks" (
        "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "agent_daemon_id"      UUID NOT NULL,
        "run_id"               TEXT NOT NULL,
        "prompt"               TEXT NOT NULL,
        "exec_options"         JSONB NOT NULL,
        "status"               TEXT NOT NULL DEFAULT 'queued',
        "claimed_by_daemon_id" UUID,
        "result"               JSONB,
        "failure_reason"       TEXT,
        "session_id"           TEXT,
        "usage"                JSONB,
        "duration_ms"          INTEGER,
        "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "claimed_at"           TIMESTAMPTZ,
        "started_at"           TIMESTAMPTZ,
        "finished_at"          TIMESTAMPTZ,
        CONSTRAINT dispatch_tasks_status_chk
          CHECK ("status" IN ('queued','claimed','running','completed','failed'))
      )
    `)
    await qr.query(
      `CREATE INDEX idx_dispatch_tasks_status_agent ON "dispatch_tasks" ("status", "agent_daemon_id")`,
    )
    await qr.query(`CREATE INDEX idx_dispatch_tasks_run ON "dispatch_tasks" ("run_id")`)

    await qr.query(`
      CREATE TABLE "dispatch_task_events" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "task_id"    UUID NOT NULL REFERENCES "dispatch_tasks"("id") ON DELETE CASCADE,
        "kind"       TEXT NOT NULL,
        "seq"        INTEGER NOT NULL,
        "payload"    JSONB NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT dispatch_task_events_kind_chk
          CHECK ("kind" IN ('message','progress','status'))
      )
    `)
    await qr.query(
      `CREATE INDEX idx_dispatch_task_events_task_seq ON "dispatch_task_events" ("task_id", "seq")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "dispatch_task_events"`)
    await qr.query(`DROP TABLE IF EXISTS "dispatch_tasks"`)
    await qr.query(`DROP TABLE IF EXISTS "agent_daemons"`)
    await qr.query(`DROP TABLE IF EXISTS "daemons"`)
  }
}
