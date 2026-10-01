import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 放宽 agents.visibility 的 check 约束（2026-10-01，Agent 广场迭代顺手修复）。
 *
 * 原约束只允许 ('workspace','public')，但 console 详情页「归档」PATCH 发的是
 * visibility:'archived'（agent-detail-view.tsx）——constraint 在 2025 年建表后
 * 从未放宽，全新库上归档操作必撞 CHECK（现网 dev 库疑似手工改过所以未暴露）。
 */
export class WidenAgentsVisibilityChk1720000101000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS agents_visibility_chk`)
    await qr.query(`
      ALTER TABLE "agents"
        ADD CONSTRAINT agents_visibility_chk
        CHECK ("visibility" IN ('workspace','public','archived'))
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS agents_visibility_chk`)
    await qr.query(`
      ALTER TABLE "agents"
        ADD CONSTRAINT agents_visibility_chk
        CHECK ("visibility" IN ('workspace','public'))
    `)
  }
}
