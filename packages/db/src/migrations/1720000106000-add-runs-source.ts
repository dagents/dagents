import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * runs 加 `source` 列（R10 试运行隔离标记，design-sharp §1.1；2026-10-07）。
 *
 * 词表 `canvas|chat|trial|resume|answer`——**不加 CHECK**：过滤只针对
 * 'trial'（读面 `IS DISTINCT FROM`），给未来新来源留零预检负担（NFR-1 的
 * 反面教训是词表收紧要存量预检）。
 *
 * 存量回填一次性幂等：`chat_id 非空 → 'chat'，否则 'canvas'`——与读面
 * 现状派生逻辑（runs.ts `r.chat_id ? 'chat' : 'canvas'`）逐字同义，迁移后
 * 读面派生退位为 COALESCE 兜底（混跑窗口双保险）。
 *
 * 部分索引 idx_runs_source_trial：`?source=trial` 显式查询零全扫；正式
 * 历史默认过滤走 NOT 条件（与既有 WHERE 组合，行数与现状同阶）。
 */
export class AddRunsSource1720000106000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "source" text`)
    await qr.query(
      `UPDATE "runs" SET "source" = CASE WHEN chat_id IS NOT NULL THEN 'chat' ELSE 'canvas' END
        WHERE "source" IS NULL`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_source_trial ON "runs" ("created_at" DESC) WHERE "source" = 'trial'`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_runs_source_trial`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "source"`)
  }
}
