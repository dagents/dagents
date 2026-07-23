import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * v0.3-M9.1 — add the design's capability-text fields to `agents`.
 *
 * The platform-owned `agents` table (created by the in-repo domain migration
 * `CreateDomainTables1720000008000`) already models the v0.3 design's agent
 * field set 1:1 as top-level columns (`instructions`, `skills`, `visibility`,
 * `concurrency`, `model`, `runtime`, `owner_id`, `activity`, `status`,
 * `availability`, …). The design's `agents-data.js` single-agent object also
 * carries `summary` + `inputSchema` + `outputSchema` (L26-28), which the
 * `agents` table does not yet have. This migration adds them as top-level
 * TEXT columns — matching the table's existing style (`instructions` /
 * `model` / `runtime` are all `TEXT NOT NULL DEFAULT ''`) rather than nesting
 * them under a JSONB descriptor.
 *
 * The `GET /api/v1/agents/:id` route (M9.1) lifts these to the design's
 * top-level field names so the response shape aligns 1:1 with
 * `agents-data.js`.
 *
 * The `up` runs unconditionally (no table-existence guard): the create-table
 * migration `1720000008000` precedes this one in the migration set, so on a
 * fresh DB the `agents` table already exists by the time this runs. The guard
 * was needed before 8000 was brought in-repo (the create-table migration was
 * missing then, so a fresh DB had no `agents` table and a bare `ALTER TABLE`
 * would hard-error); with 8000 in-repo the guard is unnecessary and a bare
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is both correct and honest about
 * the dependency. `ADD COLUMN IF NOT EXISTS` keeps it idempotent on re-runs.
 */
export class AddAgentsCapabilityFields1720000008001 implements MigrationInterface {
  name = 'AddAgentsCapabilityFields1720000008001'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "agents"
        ADD COLUMN IF NOT EXISTS "summary" TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "input_schema" TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "output_schema" TEXT NOT NULL DEFAULT '';
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "agents"
        DROP COLUMN IF EXISTS "summary",
        DROP COLUMN IF EXISTS "input_schema",
        DROP COLUMN IF EXISTS "output_schema";
    `)
  }
}
