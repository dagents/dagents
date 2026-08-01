import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M4.1 — pipeline_versions table (spec §5.3, architecture v0.2 §5.3).
 *
 * Originally created to补 Flowise 无版本锁定的短板: the platform owns
 * `pipeline_versions` as the immutable content-addressed snapshot of a flow —
 * the full JSON plus its SHA-256, with `version_hash` UNIQUE so a re-snapshot
 * of an unchanged flow reuses the row.
 *
 * NOTE: The runtime consumer (`@dagents/repro`) was removed on 2026-08-01.
 * This migration is retained for schema continuity — never delete applied
 * migrations. The table currently has no runtime readers or writers.
 *
 * Indexes (spec §5.3):
 *   - (version_hash) UNIQUE   dedup + content-addressed lookup
 *   - (pipeline_id)           list versions of one flow
 */
export class CreatePipelineVersions1720000003000 implements MigrationInterface {
  name = 'CreatePipelineVersions1720000003000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "pipeline_versions" (
        "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "pipeline_id"        TEXT NOT NULL,
        "version_hash"       CHAR(64) NOT NULL,
        "flow_json"          JSONB NOT NULL,
        "created_by_user_id" UUID,
        "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "note"               TEXT
      )
    `)
    await qr.query(
      `CREATE UNIQUE INDEX idx_pipeline_versions_version_hash ON "pipeline_versions" ("version_hash")`,
    )
    await qr.query(
      `CREATE INDEX idx_pipeline_versions_pipeline_id ON "pipeline_versions" ("pipeline_id")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "pipeline_versions"`)
  }
}
