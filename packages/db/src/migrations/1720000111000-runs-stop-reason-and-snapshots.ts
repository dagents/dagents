import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * runs 中止来源 + run 级快照 + spans 实例键标注列（2026-10-07 可恢复性 R3/R8，
 * design-recover §1.2/§1.3）。
 *
 *  - `stop_reason`（AD-R7 五值，无死值）：stopped 行 user（旧 cancelled 写新）
 *    / interrupted（boot sweep）/ superseded（chat 域 latest-wins）；failed 行
 *    model（默认）/ provider（pin 拒绝降级）；其余状态行恒 NULL。
 *  - `runs.status` CHECK 重建为九值——`cancelled` 显式保留（NFR-1 写新读旧：
 *    存量行不迁移，读侧双读）。范式对齐 1720000103000。
 *  - `frozen_agents`（AD-R6）：run 创建期的 persona 快照（跨进程存活的 resume
 *    冻结载体）；`models`：run 级 resolvedModel 快照（AC-R8-4 可查性）。
 *  - `run_node_spans.ordinal`：存量行默认 0（行为不劣于今天）——唯一索引不动，
 *    ordinal 只做标注列（终端 `nodeId[ordinal]`），不参与键；迭代的
 *    per-ordinal 完整事实在 run_node_journal（AD-R1）。
 *
 * runs 大表 ALTER 均为可空列 + DEFAULT 0 元数据操作（PostgreSQL 11+ 短事务，
 * 不重写表），长锁风险低（§⑤）。
 */
export class RunsStopReasonAndSnapshots1720000111000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    // 1. stop_reason：TEXT NULL + 五值 CHECK（NULL 表示非 stopped/failed 来源）
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "stop_reason" TEXT NULL`)
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_stop_reason_chk`)
    await qr.query(`
      ALTER TABLE "runs"
        ADD CONSTRAINT runs_stop_reason_chk
        CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('user','interrupted','superseded','model','provider'))
    `)

    // 2. status CHECK 重建为九值（cancelled 显式保留——写新读旧，存量行零改写）
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_status_chk`)
    await qr.query(`
      ALTER TABLE "runs"
        ADD CONSTRAINT runs_status_chk
        CHECK ("status" IN ('pending','running','awaiting_input','completed','failed','cancelled','partial_success','budget_exceeded','stopped'))
    `)

    // 3. persona 创建期冻结快照（R8）：{ [agentId]: { instructions, model, kind, skills } }
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "frozen_agents" JSONB NULL`)

    // 4. run 级模型快照（R8）：{ [nodeId]: resolvedModel }
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "models" JSONB NULL`)

    // 5. spans 实例键标注列：只标注、不进键（唯一索引保持 (run_id, node_id)）
    await qr.query(
      `ALTER TABLE "run_node_spans" ADD COLUMN IF NOT EXISTS "ordinal" INTEGER NOT NULL DEFAULT 0`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "run_node_spans" DROP COLUMN IF EXISTS "ordinal"`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "models"`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "frozen_agents"`)
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_stop_reason_chk`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "stop_reason"`)
    // CHECK 退回八值词表（对齐 1720000103000 现状；存量 stopped 行存在时 down
    // 会失败——逃生门不是往返保证，仓库既有范式）。
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_status_chk`)
    await qr.query(`
      ALTER TABLE "runs"
        ADD CONSTRAINT runs_status_chk
        CHECK ("status" IN ('pending','running','awaiting_input','completed','failed','cancelled','partial_success','budget_exceeded'))
    `)
  }
}
