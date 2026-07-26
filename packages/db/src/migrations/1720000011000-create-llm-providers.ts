import type { MigrationInterface, QueryRunner } from 'typeorm'

export class CreateLlmProviders1720000011000 implements MigrationInterface {
  name = 'CreateLlmProviders1720000011000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "llm_providers" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "directory_id"    UUID,
        "name"            TEXT NOT NULL,
        "provider_type"   TEXT NOT NULL DEFAULT 'openai_compatible',
        "base_url"        TEXT NOT NULL,
        "api_key"         TEXT NOT NULL,
        "default_model"   TEXT NOT NULL,
        "models"          JSONB NOT NULL DEFAULT '[]'::jsonb,
        "status"          TEXT NOT NULL DEFAULT 'active',
        "remark"          TEXT,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT llm_providers_status_chk
          CHECK ("status" IN ('active','disabled'))
      )
    `)
    await qr.query(
      `CREATE INDEX idx_llm_providers_directory ON "llm_providers" ("directory_id")`,
    )
    await qr.query(
      `CREATE INDEX idx_llm_providers_status ON "llm_providers" ("status")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "llm_providers"`)
  }
}
