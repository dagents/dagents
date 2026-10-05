import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 放宽 runs.status 的 check 约束（2026-10-04 多人格优化轮）。
 *
 * 引擎新增两个终态：partial_success（失败分支隔离——isolateFailure 节点
 * 失败只塌本分支，run 带产出收尾）与 budget_exceeded（run 级 tokenBudget
 * 越线停机）。e2e 实弹逮出：约束不放宽，终态 upsert 被 CHECK 拒收，
 * runs 行永远停在 running（spans 已终态、行却悬空）。
 */
export class WidenRunsStatusChk1720000103000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_status_chk`)
    await qr.query(`
      ALTER TABLE "runs"
        ADD CONSTRAINT runs_status_chk
        CHECK ("status" IN ('pending','running','awaiting_input','completed','failed','cancelled','partial_success','budget_exceeded'))
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_status_chk`)
    await qr.query(`
      ALTER TABLE "runs"
        ADD CONSTRAINT runs_status_chk
        CHECK ("status" IN ('pending','running','awaiting_input','completed','failed','cancelled'))
    `)
  }
}
