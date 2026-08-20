import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Agent Library（docs/agent-library.md D4）— `agents.library_meta` 溯源列。
 *
 * 从人格库（如 agency-agents）instantiate 出来的 agents 行在此列记录出处：
 *
 *   {
 *     id: '<division>/<slug>'                  稳定库寻址键（reimport 按此定位）
 *     source_path, source_sha256               库文件路径 + 导入时全文指纹
 *     instructions_sha256_at_import            导入时 instructions 指纹
 *     division, profile, imported_at, reimported_at
 *   }
 *
 * drift 三态（upstream-updated / locally-modified / diverged）的全部输入都在
 * 这一列里，reimport 覆盖 instructions 而 id 不变 —— 已引用该 agent 的工作流
 * agentId 不失效。手工创建的 agents 行该列为 NULL，行为不变。
 */
export class AddAgentsLibraryMeta1720000015000 implements MigrationInterface {
  name = 'AddAgentsLibraryMeta1720000015000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "library_meta" JSONB`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "library_meta"`)
  }
}
