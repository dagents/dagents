import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * flow_versions —— flow 版本快照链（2026-10-04 稳定性/可回滚专项）。
 *
 * 此前 flows 表只有当前态：改坏一张跑了很多轮的 flow 后无法回到上一版
 * （runs 存运行输入不存结构快照；断点续跑的拓扑指纹反而衬出「结构历史」
 * 缺失）。每次结构保存（flow_data 变更）写一份前版本快照，保留最近 20 版
 * （repo 层裁剪），一键回滚 = 用快照覆盖 flows.flow_data。
 */
export class FlowVersions1720000102000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "flow_versions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "flow_id" uuid NOT NULL,
        "name" text NOT NULL,
        "flow_data" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_flow_versions_flow
          FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_flow_versions_flow_created ON flow_versions (flow_id, created_at DESC)`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "flow_versions"`)
  }
}
