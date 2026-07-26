import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddLlmProviderAuditTargetType1720000013000 implements MigrationInterface {
  name = 'AddLlmProviderAuditTargetType1720000013000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "audit_log"
        DROP CONSTRAINT IF EXISTS "audit_log_target_type_chk",
        ADD CONSTRAINT "audit_log_target_type_chk"
          CHECK ("target_type" IN ('token','pipeline_version','llm_provider'))
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "audit_log"
        DROP CONSTRAINT IF EXISTS "audit_log_target_type_chk",
        ADD CONSTRAINT "audit_log_target_type_chk"
          CHECK ("target_type" IN ('token','pipeline_version'))
    `)
  }
}
