import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M6.6 — audit_log table (spec §1.4 gateway 职责 #5 "审计日志（敏感操作）";
 * plan M6.6 / P1.4.T6; risk R15 — token-rotation misuse needs an audit trail).
 *
 * The gateway is the single choke point for sensitive mutations (token CRUD,
 * version locking, token rotation), so it owns the audit trail. An audit record
 * captures WHO (actor_type/actor_id) did WHAT (action) to WHICH object
 * (target_type/target_id), plus the OTel-threaded run_id (M6.1) for end-to-end
 * trace correlation, optional workspace scope, a jsonb `detail` for
 * operation-specific context, and best-effort caller ip/user-agent.
 *
 * `actor_type` / `target_type` are open TEXT + CHECK constraints so new
 * principal / resource kinds can be added without a migration — same pattern as
 * `runs.status`. `action` is free-form TEXT (e.g. 'token.create') so the
 * gateway can coin new audited verbs without a DDL change.
 *
 * Mirrors the raw-SQL-1:1 style of the runs / token_meta migrations: the
 * gateway writes this table with parameterised raw SQL via `runQuery`; the
 * entity class exists for the schema definition + repository typing and is not
 * loaded on the runtime query path.
 *
 * Indexes:
 *   - (created_at)            chronological audit browse / retention sweeps
 *   - (actor_type, actor_id)  "what did this user do" queries
 *   - (target_type, target_id) "what happened to this token / version"
 *   - (run_id)                end-to-end trace correlation (M6.1)
 */
export class CreateAuditLog1720000004000 implements MigrationInterface {
  name = 'CreateAuditLog1720000004000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "audit_log" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "actor_type"    TEXT NOT NULL,
        "actor_id"      TEXT NOT NULL,
        "action"        TEXT NOT NULL,
        "target_type"   TEXT NOT NULL,
        "target_id"     TEXT NOT NULL,
        "run_id"        TEXT,
        "workspace_id"  UUID,
        "detail"        JSONB NOT NULL DEFAULT '{}'::jsonb,
        "ip"            TEXT,
        "user_agent"    TEXT,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT audit_log_actor_type_chk
          CHECK ("actor_type" IN ('user','system')),
        CONSTRAINT audit_log_target_type_chk
          CHECK ("target_type" IN ('token','pipeline_version'))
      )
    `)
    await qr.query(`CREATE INDEX idx_audit_log_created_at ON "audit_log" ("created_at")`)
    await qr.query(
      `CREATE INDEX idx_audit_log_actor ON "audit_log" ("actor_type", "actor_id")`,
    )
    await qr.query(
      `CREATE INDEX idx_audit_log_target ON "audit_log" ("target_type", "target_id")`,
    )
    await qr.query(`CREATE INDEX idx_audit_log_run_id ON "audit_log" ("run_id")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "audit_log"`)
  }
}
