import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M5b.2 — Lab multi-agent chat room tables (spec §6.2; plan M5b.2 / P1.10.T7;
 * dependency table P1.2.T9).
 *
 * Lab is the multi-agent collaboration room: an experiment session gathers
 * several agents (orchestrator / reader / coder / verifier / …) into one
 * threaded conversation that produces hypotheses, data, code, and reproducible
 * artifacts. The platform owns two tables:
 *   - lab_sessions    one row per experiment (name / desc / status / mode / workspace)
 *   - lab_messages    the threaded turns (role / agent_id / run_id / body / thinking / tool_call)
 *
 * `workspace_id` is a loose UUID reference to `workspaces(id)`, NOT a FK — the
 * same no-FK posture `runs.workspace_id` takes (a lab session survives a
 * workspace being archived/dropped without a cascading delete). It is nullable
 * so a free-form experiment unattached to a project is valid. If the
 * workspaces table does not exist yet on a fresh DB (M5b.1 in review), this
 * migration still applies cleanly because there is no FK to satisfy.
 *
 * `lab_messages.session_id` IS a FK → lab_sessions(id) ON DELETE CASCADE so
 * dropping a session cleans its thread; `parent_id` is a self-reference (no
 * FK, to avoid cycles in the migration up-order and to keep the reply link
 * editorial — a parent may be hard-deleted while a reply lingers, which the
 * MVP flat render tolerates).
 *
 * `run_id` reuses the OTel-threaded run id (M6.1) so a lab message is
 * end-to-end traceable. It is free TEXT (not a FK to `runs.id`) for the same
 * open-id posture `runs` itself takes.
 *
 * Mirrors the raw-SQL-1:1 style of the audit_log / workspace migrations: the
 * gateway queries these tables with parameterised raw SQL via `runQuery`; the
 * entity classes exist for the schema definition + repository typing and are
 * not loaded on the runtime query path.
 *
 * Indexes:
 *   - lab_sessions (workspace_id)   "which experiments belong to this project"
 *   - lab_sessions (status)         active-vs-paused-vs-done list filter
 *   - lab_messages (session_id)     "the thread for this session" (hot path)
 *   - lab_messages (parent_id)      reply-tree reconstruction (future)
 *   - lab_messages (run_id)         end-to-end trace correlation (M6.1)
 */
export class CreateLabTables1720000006000 implements MigrationInterface {
  name = 'CreateLabTables1720000006000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "lab_sessions" (
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
    await qr.query(`CREATE INDEX idx_lab_sessions_workspace ON "lab_sessions" ("workspace_id")`)
    await qr.query(`CREATE INDEX idx_lab_sessions_status ON "lab_sessions" ("status")`)

    await qr.query(`
      CREATE TABLE "lab_messages" (
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
    await qr.query(`CREATE INDEX idx_lab_messages_session ON "lab_messages" ("session_id")`)
    await qr.query(`CREATE INDEX idx_lab_messages_parent ON "lab_messages" ("parent_id")`)
    await qr.query(`CREATE INDEX idx_lab_messages_run_id ON "lab_messages" ("run_id")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "lab_messages"`)
    await qr.query(`DROP TABLE IF EXISTS "lab_sessions"`)
  }
}
