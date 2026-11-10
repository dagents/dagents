import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 目标环（Goal Loop，方向 C，2026-11-10，docs/team-collaboration-ui-research.md）。
 *
 * goals：给「为同一目标持续前进」一个实体——目标/验收标准/预算/轮次状态机。
 * runs.goal_id：轮次谱系（一个 goal 的每一轮是一个 run 行；目标看板的
 * 时间线/成本 rollup 都从这条外键聚合，不另建轮次表）。
 *
 * 状态机：active（自动推进中）→ awaiting_eval（本轮跑完待评估）→
 * achieved / paused；evaluator 的结论落 last_eval_*，预算耗尽自动 paused。
 */
export class CreateGoals1720000106000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "goals" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "acceptance" TEXT NOT NULL DEFAULT '',
        "flow_id" UUID,
        "directory_id" UUID,
        "budget_usd" NUMERIC(12, 2),
        "auto" BOOLEAN NOT NULL DEFAULT false,
        "status" TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'awaiting_eval', 'achieved', 'paused', 'archived')),
        "round" INT NOT NULL DEFAULT 0,
        "max_rounds" INT NOT NULL DEFAULT 10,
        "last_run_id" UUID,
        "last_eval" TEXT,
        "last_eval_passed" BOOLEAN,
        "last_eval_run_id" UUID,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await qr.query(`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "goal_id" UUID`)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS "idx_runs_goal_id" ON "runs" ("goal_id") WHERE "goal_id" IS NOT NULL`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS "idx_goals_status" ON "goals" ("status")`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS "idx_goals_status"`)
    await qr.query(`DROP INDEX IF EXISTS "idx_runs_goal_id"`)
    await qr.query(`ALTER TABLE "runs" DROP COLUMN IF EXISTS "goal_id"`)
    await qr.query(`DROP TABLE IF EXISTS "goals"`)
  }
}
