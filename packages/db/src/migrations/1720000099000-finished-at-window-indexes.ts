import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * fleet 仪表 finished_at 窗口索引（架构优化轮二，2026-09-19）。
 *
 * fleet-stats 由资源仪表盘 UI 轮询，其吞吐/成本滚动查询此前对 runs 与
 * dispatch_tasks 全表扫：
 *  - `WHERE finished_at IS NOT NULL AND finished_at >= $1`（双表窗口聚合）
 *  - `SUM(cost) FILTER (WHERE finished_at >= $1)`（runs 全表）
 *  - `ORDER BY finished_at DESC NULLS LAST LIMIT 50000`（allAgentDaemonCalls）
 *
 * runs 走部分覆盖索引（INCLUDE cost → index-only scan）；dispatch_tasks
 * 部分索引即可。两者都以 finished_at IS NOT NULL 为前提条件，索引只装
 * 已终结行，写入放大最小化。
 */
export class FinishedAtWindowIndexes1720000099000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_finished_at_cost
         ON runs (finished_at DESC) INCLUDE (cost)
         WHERE finished_at IS NOT NULL`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_finished_at
         ON dispatch_tasks (finished_at DESC)
         WHERE finished_at IS NOT NULL`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_dispatch_tasks_finished_at`)
    await qr.query(`DROP INDEX IF EXISTS idx_runs_finished_at_cost`)
  }
}
