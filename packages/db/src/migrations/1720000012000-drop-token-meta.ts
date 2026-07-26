import type { MigrationInterface, QueryRunner } from 'typeorm'

export class DropTokenMeta1720000012000 implements MigrationInterface {
  name = 'DropTokenMeta1720000012000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "token_meta"`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "token_meta" (
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
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_token_meta_newapi_token_id ON "token_meta" ("newapi_token_id")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_token_meta_workspace ON "token_meta" ("workspace_id")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_token_meta_status ON "token_meta" ("status")`,
    )
  }
}
