import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 执行状态检查点与断点续跑（docs/design-run-checkpoint-resume.md，2026-09-18）。
 *
 * 三件事：
 * 1. `run_checkpoints` 表 —— 执行控制态快照（outputs/runtime/迭代游标）。
 *    与 run_node_spans（观测态，末次覆盖）分离，见设计 §5 方案对比。
 * 2. runs.status 放宽 + 'awaiting_input'（HumanInput 持久挂起）。
 * 3. runs.resumed_from_run_id —— 续跑谱系链（设计 §9 开放问题的落地裁决）。
 */
export class CreateRunCheckpoints1720000096000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "run_checkpoints" (
        "run_id"     UUID PRIMARY KEY,
        "flow_id"    UUID NOT NULL,
        "status"     TEXT NOT NULL,
        "topo_hash"  TEXT NOT NULL,
        "snapshot"   JSONB NOT NULL,
        "awaiting"   JSONB,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT run_checkpoints_status_chk
          CHECK ("status" IN ('running','awaiting_input','resumable','terminal'))
      )
    `)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_run_checkpoints_status ON "run_checkpoints" ("status")`,
    )

    // runs.status：放宽 CHECK 加入 'awaiting_input'（非终态：应答后以
    // resume 语义续跑；超时/清扫收敛为 failed）
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_status_chk`)
    await qr.query(`
      ALTER TABLE "runs" ADD CONSTRAINT runs_status_chk
        CHECK ("status" IN ('pending','running','awaiting_input','completed','failed','cancelled'))
    `)

    // 续跑谱系：resumed run 指回原 run（checkpoint 行保持原 run_id 不变）
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "resumed_from_run_id" UUID`)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_resumed_from ON "runs" ("resumed_from_run_id")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "run_checkpoints"`)
    await qr.query(`ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS runs_status_chk`)
    await qr.query(`
      ALTER TABLE "runs" ADD CONSTRAINT runs_status_chk
        CHECK ("status" IN ('pending','running','completed','failed','cancelled'))
    `)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "resumed_from_run_id"`)
  }
}
