import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddWorkflowAuditTargetType1720000015000 implements MigrationInterface {
  name = 'AddWorkflowAuditTargetType1720000015000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "audit_log"
        DROP CONSTRAINT IF EXISTS "audit_log_target_type_chk",
        ADD CONSTRAINT "audit_log_target_type_chk"
          CHECK ("target_type" IN ('token','pipeline_version','llm_provider','workflow','agent','chat'))
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "audit_log"
        DROP CONSTRAINT IF EXISTS "audit_log_target_type_chk",
        ADD CONSTRAINT "audit_log_target_type_chk"
          CHECK ("target_type" IN ('token','pipeline_version','llm_provider'))
    `)
  }
}
