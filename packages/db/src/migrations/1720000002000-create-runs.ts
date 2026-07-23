import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M3.2 — runs table (spec §5.3, architecture §4.3; P1.2.T4 landed late because
 * it ships with its first real consumer — M3.2 fan-out).
 *
 * Flowise has no native "execution instance" table (architecture v0.2 §4.3),
 * so the platform owns `runs` as the trackable unit of a single prediction
 * execution. M3.2 fans a batch input out into N child runs, each linked back to
 * one parent run via `parent_run_id`; the parent aggregates child outcomes.
 *
 * Schema mirrors the spec 1:1. `pipeline_version_hash` is nullable for MVP
 * runs that haven't been bound to a repro snapshot yet (M4 binds it); the
 * fan-out worker sets `parent_run_id` on child rows only. Status is an open
 * TEXT with a CHECK constraint so new lifecycle states (checkpoint, rerun)
 * can be added without a migration — kept distinct from `dispatch_tasks`
 * status, which models the daemon pull protocol, not run lifecycle.
 *
 * Mirrors the raw-SQL-1:1 style of the dispatch / token_meta migrations: the
 * scheduler queries this table with parameterised raw SQL via `runQuery`; the
 * entity class exists for the schema definition + repository typing and is not
 * loaded on the runtime query path (same decorator-free-reads rationale as
 * `token_meta`).
 *
 * Indexes (spec §5.3):
 *   - (workspace_id, status)   listing/monitoring by workspace
 *   - (parent_run_id)          parent ↔ child tree walks in fan-out aggregation
 *   - (pipeline_version_hash)  repro lookup by version (M4)
 */
export class CreateRuns1720000002000 implements MigrationInterface {
  name = 'CreateRuns1720000002000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "runs" (
        "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "identifier"             TEXT NOT NULL,
        "pipeline_id"            TEXT NOT NULL,
        "pipeline_version_hash"  CHAR(64),
        "status"                 TEXT NOT NULL DEFAULT 'pending',
        "created_by_user_id"     UUID,
        "created_by_run_id"      UUID,
        "parent_run_id"          UUID,
        "input"                  JSONB NOT NULL DEFAULT '{}'::jsonb,
        "output"                 JSONB,
        "artifact_uri"           TEXT,
        "agent_daemon_calls"     JSONB NOT NULL DEFAULT '[]'::jsonb,
        "cost"                   NUMERIC(18,6) NOT NULL DEFAULT 0,
        "trace_id"               TEXT,
        "workspace_id"           TEXT,
        "started_at"             TIMESTAMPTZ,
        "finished_at"            TIMESTAMPTZ,
        "duration_ms"            INTEGER,
        "created_at"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT runs_status_chk
          CHECK ("status" IN ('pending','running','completed','failed','cancelled'))
      )
    `)
    await qr.query(
      `CREATE INDEX idx_runs_workspace_status ON "runs" ("workspace_id", "status")`,
    )
    await qr.query(`CREATE INDEX idx_runs_parent ON "runs" ("parent_run_id")`)
    await qr.query(
      `CREATE INDEX idx_runs_version_hash ON "runs" ("pipeline_version_hash")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "runs"`)
  }
}
