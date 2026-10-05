import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * flow 级上下文文件（2026-10-04 P2a）。
 *
 * flows 加 `context_md`（画布可编辑的流程上下文，注入 LLM/Agent 节点
 * system 前部——CLAUDE.md 生态直觉的 flow 版）；flow_versions 同步加列，
 * 快照/回滚与结构一起走（回滚上下文不漂移）。
 */
export class FlowContextMd1720000105000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "context_md" text`)
    await qr.query(`ALTER TABLE "flow_versions" ADD COLUMN IF NOT EXISTS "context_md" text`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "flow_versions" DROP COLUMN IF EXISTS "context_md"`)
    await qr.query(`ALTER TABLE "flows" DROP COLUMN IF EXISTS "context_md"`)
  }
}
