import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 生成遥测 + 成本账单两张表（docs/product-architecture.md AD-3 / AD-4）。
 *
 * `generator_attempts`（AD-4，方案 A5 埋点）—— AI 生成工作流每次尝试一条
 * 追加式记录：来源（chat / canvas）、引擎路径（CLI 第一性，HTTP 降级）、
 * 修复轮数、校验错误、结局与耗时。不混 audit_log（audit 是安全审计语义，
 * 高频生成遥测会稀释信噪）。`raw_output_preview` 为截断后的原始 LLM 输出
 * 前 500 字，仅调试用。
 *
 * `usage_events`（AD-3，方案 D）—— 成本账单唯一真相源：chat / workflow run /
 * dispatch task 终态各写一条，账单页只读此表。`usage` 为 token 用量结构
 * （prompt/completion/total 等），`priced=false` 表示写入时单价未知
 * （cost 为 NULL），价格表更新后可离线回算。旧的 4 处 usage 数据不回填，
 * 只管增量。
 *
 * 两表均不做外键（仓库现状：运行时 raw SQL、跨域松散引用 —— 参照
 * chats.agent_id / chat_messages.run_id 的既有风格），引用列可空。
 * 规矩（docs §「事件系统规则成文」）：WS 帧只是 UI 推送，DB 表才是真相源。
 */
export class CreateTelemetryTables1720000091000 implements MigrationInterface {
  name = 'CreateTelemetryTables1720000091000'

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "generator_attempts" (
        "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "source"             TEXT NOT NULL,
        "engine"             TEXT NOT NULL,
        "user_desc"          TEXT NOT NULL,
        "repair_rounds"      INTEGER NOT NULL DEFAULT 0,
        "validation_errors"  JSONB NOT NULL DEFAULT '[]'::jsonb,
        "outcome"            TEXT NOT NULL,
        "flow_id"            UUID,
        "chat_id"            UUID,
        "duration_ms"        INTEGER,
        "raw_output_preview" TEXT,
        CONSTRAINT generator_attempts_source_chk
          CHECK ("source" IN ('chat','canvas')),
        CONSTRAINT generator_attempts_engine_chk
          CHECK ("engine" IN ('cli','http','cli-then-http')),
        CONSTRAINT generator_attempts_outcome_chk
          CHECK ("outcome" IN ('success','failed_validation','llm_error','user_abandoned'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_generator_attempts_created_at ON "generator_attempts" ("created_at")`,
    )

    await qr.query(`
      CREATE TABLE IF NOT EXISTS "usage_events" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "source"     TEXT NOT NULL,
        "chat_id"    UUID,
        "run_id"     UUID,
        "task_id"    UUID,
        "agent_id"   UUID,
        "flow_id"    TEXT,
        "model"      TEXT,
        "usage"      JSONB NOT NULL,
        "cost"       NUMERIC(18,6),
        "priced"     BOOLEAN NOT NULL DEFAULT FALSE,
        CONSTRAINT usage_events_source_chk
          CHECK ("source" IN ('chat','workflow_run','dispatch_task'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON "usage_events" ("created_at")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_chat_id ON "usage_events" ("chat_id")`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_run_id ON "usage_events" ("run_id")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_usage_events_run_id`)
    await qr.query(`DROP INDEX IF EXISTS idx_usage_events_chat_id`)
    await qr.query(`DROP INDEX IF EXISTS idx_usage_events_created_at`)
    await qr.query(`DROP TABLE IF EXISTS "usage_events"`)
    await qr.query(`DROP INDEX IF EXISTS idx_generator_attempts_created_at`)
    await qr.query(`DROP TABLE IF EXISTS "generator_attempts"`)
  }
}
