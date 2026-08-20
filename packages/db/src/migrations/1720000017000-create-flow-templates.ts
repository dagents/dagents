import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Flow Templates（docs/flow-templates.md §2.2）— 用户从画布「另存为模板」
 * 抽取的流程模板表（内置模板不住库：in-repo JSON 静态 import，见
 * `src/flow-templates/builtin/index.ts`）。
 *
 * `flow_data` 与 flows 表同构（platformAgent 节点的 inputs.agentId 为空，
 * 由 `agent_refs` 按 nodeId → personaName 引用，实例化时重绑或降级）。
 * `source_flow_id` 溯源抽取自哪条 flow（可空，源头删除不级联）。
 */
export class CreateFlowTemplates1720000017000 implements MigrationInterface {
  name = 'CreateFlowTemplates1720000017000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "flow_templates" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"           VARCHAR(255) NOT NULL,
        "description"    TEXT,
        "icon"           VARCHAR(16) NOT NULL DEFAULT '📄',
        "category"       VARCHAR(32) NOT NULL DEFAULT 'custom',
        "flow_data"      JSONB NOT NULL,
        "agent_refs"     JSONB NOT NULL DEFAULT '[]'::jsonb,
        "source_flow_id" UUID,
        "created_by"     TEXT NOT NULL DEFAULT 'local',
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT flow_templates_category_chk
          CHECK ("category" IN ('dev','research','content','ops','custom'))
      )
    `)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_flow_templates_category ON "flow_templates" ("category")`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "flow_templates"`)
  }
}
