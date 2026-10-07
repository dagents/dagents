import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `run_node_journal` —— journal 真相源（2026-10-07 可恢复性 R1/R7，design-recover §1.1）。
 *
 * 单表同时承载 R1 决策记录（kind='decision'，onNodeEnd 终态写：种子/暖缓存/
 * resume 的复用依据）与 R7 事件流（kind='event'，live 帧的持久层——404 回放
 * 由 event 行前缀重建 hello.replay）。`run_node_spans` 降格为观测投影（读面
 * 兼容层）：其 `(run_id, node_id)` 唯一索引是 console 全链消费键，不重建为
 * 复合键；迭代的 per-ordinal 完整事实在本表（AD-R1/AD-R2）。
 *
 * 口径备注：
 *  - `flow_id` 用 TEXT 对齐既有 de facto（spans.flow_id TEXT、runs.pipeline_id
 *    TEXT），与 flows.id（UUID）join 沿用显式 ::text cast。
 *  - `ordinal` 是 per-node 执行实例序号（AD-R4：每 nodeId 从 0 单调递增；
 *    非迭代节点恒 0；迭代 body 第 n 次执行 = n）。
 *  - `seq` 是 per-run 单调全序（registry emit() 单点分配，AD-R5）；
 *    `(run_id, seq)` 唯一索引是双写者抢号的保险丝（单写者模型下不触发）。
 *  - decision 部分唯一索引 `(run_id, node_id, ordinal) WHERE kind='decision'`
 *    兑现 AC-R1-2「每 (nodeId, ordinal) 一档」。
 */
export class CreateRunNodeJournal1720000110000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "run_node_journal" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "run_id"     UUID NOT NULL,
        "flow_id"    TEXT NOT NULL,
        "node_id"    TEXT NOT NULL,
        "ordinal"    INTEGER NOT NULL DEFAULT 0,
        "kind"       TEXT NOT NULL,
        "seq"        BIGINT NOT NULL,
        "event_type" TEXT,
        "payload"    JSONB NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT run_node_journal_kind_chk CHECK ("kind" IN ('decision','event'))
      )
    `)
    await qr.query(`
      CREATE UNIQUE INDEX uq_run_node_journal_run_seq
        ON "run_node_journal" ("run_id", "seq")
    `)
    await qr.query(`
      CREATE UNIQUE INDEX uq_run_node_journal_decision
        ON "run_node_journal" ("run_id", "node_id", "ordinal")
        WHERE kind = 'decision'
    `)
    await qr.query(`
      CREATE INDEX idx_run_node_journal_lookup
        ON "run_node_journal" ("run_id", "node_id", "kind")
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_run_node_journal_lookup`)
    await qr.query(`DROP INDEX IF EXISTS uq_run_node_journal_decision`)
    await qr.query(`DROP INDEX IF EXISTS uq_run_node_journal_run_seq`)
    await qr.query(`DROP TABLE IF EXISTS "run_node_journal"`)
  }
}
