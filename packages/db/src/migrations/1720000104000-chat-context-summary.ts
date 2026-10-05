import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 聊天滚动摘要（2026-10-04 P1b 两级历史）。
 *
 * chats 加 `context_summary`（滚动 checkpoint，dsh 八节裁剪为 chat 版）与
 * `context_summary_watermark`（已折叠到哪条消息：取该消息 id 的 UUID）。
 * 检索器升级为「摘要 + 最近 K 条原文」混合注入——更早的对话浓缩进摘要，
 * 细节仍在 chat_messages（落盘层），上下文不再随会话长度线性膨胀。
 */
export class ChatContextSummary1720000104000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "context_summary" text`)
    await qr.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "context_summary_watermark" uuid`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "context_summary_watermark"`)
    await qr.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "context_summary"`)
  }
}
