import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * M2.8 — token_meta table (spec §6.2, P1.2.T7).
 *
 * Local metadata for new-api tokens. new-api owns the key + quota lifecycle;
 * this table holds only editorial metadata (label/group/visibility/remark) the
 * gateway maintains, plus the result of its own health probe. The raw token key
 * is NEVER stored — `newapi_token_id` is the int FK back to new-api's
 * `tokens.id`, and new-api masks the key in its own API responses.
 *
 * Mirrors the raw-SQL-1:1 style of `1720000000000-create-dispatch-tables.ts`
 * (the gateway queries this table with parameterised raw SQL via `runQuery`;
 * the entity class exists for the schema definition and is not loaded on the
 * runtime query path).
 */
export class CreateTokenMeta1720000001000 implements MigrationInterface {
  name = 'CreateTokenMeta1720000001000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "token_meta" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "newapi_token_id" BIGINT NOT NULL,
        "name"            TEXT NOT NULL,
        "group"           TEXT NOT NULL DEFAULT 'default',
        "remark"          TEXT,
        "visibility"      TEXT NOT NULL DEFAULT 'workspace',
        "workspace_id"    UUID,
        "status"          TEXT NOT NULL DEFAULT 'unknown',
        "last_probed_at"  TIMESTAMPTZ,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT token_meta_status_chk
          CHECK ("status" IN ('unknown','active','disabled','expired','exhausted','rate_limited','error')),
        CONSTRAINT token_meta_visibility_chk
          CHECK ("visibility" IN ('private','workspace','public'))
      )
    `)
    await qr.query(
      `CREATE UNIQUE INDEX idx_token_meta_newapi_token_id ON "token_meta" ("newapi_token_id")`,
    )
    await qr.query(
      `CREATE INDEX idx_token_meta_workspace ON "token_meta" ("workspace_id")`,
    )
    await qr.query(`CREATE INDEX idx_token_meta_status ON "token_meta" ("status")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "token_meta"`)
  }
}
