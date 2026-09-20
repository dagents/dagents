import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 热点查询索引补课 + 冗余索引清理（架构优化轮，2026-09-19）。
 *
 * runs / dispatch_tasks / chats 随使用量线性增长，以下高频查询此前全部
 * 顺序扫描（审计证据见各索引注释）：
 *  - agents 目录页每行一次 LATERAL 探测 + agent 详情最近任务：
 *    dispatch_tasks(agent_daemon_id, created_at DESC)（agents.repo.ts 三处）
 *  - 运行历史 / workflows 页徽标批量汇总：runs(pipeline_id, created_at DESC)
 *    （listRunsHistory / summarizeRunsByFlow）
 *  - 默认运行列表：runs(created_at DESC)（GET /runs 无过滤分支）
 *  - 全局会话列表：chats(updated_at DESC)（chats 永不清理，retention 豁免；
 *    既有 idx_chats_directory 只覆盖目录内分支）
 *  - agent 详情 / fleet 仪表 JSONB 包含查询：runs(agent_daemon_calls) GIN
 *    （listRunsTouchingAgentDaemon / regionBreakdown）
 *
 * 同时删除被 uq_run_node_spans_run_node（1720000093000，同列唯一索引）
 * 完全遮蔽的非唯一索引 idx_run_node_spans_run_node —— span-writer 每秒
 * 级 upsert 的最热写表一直在付双倍索引维护。
 */
export class OptimizeHotPathIndexes1720000098000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_daemon_created
         ON dispatch_tasks (agent_daemon_id, created_at DESC)`,
    )
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_pipeline_created
         ON runs (pipeline_id, created_at DESC)`,
    )
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at DESC)`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats (updated_at DESC)`)
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_runs_agent_daemon_calls_gin
         ON runs USING gin (agent_daemon_calls jsonb_path_ops)`,
    )
    await qr.query(`DROP INDEX IF EXISTS idx_run_node_spans_run_node`)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_runs_agent_daemon_calls_gin`)
    await qr.query(`DROP INDEX IF EXISTS idx_chats_updated_at`)
    await qr.query(`DROP INDEX IF EXISTS idx_runs_created_at`)
    await qr.query(`DROP INDEX IF EXISTS idx_runs_pipeline_created`)
    await qr.query(`DROP INDEX IF EXISTS idx_dispatch_tasks_daemon_created`)
    await qr.query(`CREATE INDEX IF NOT EXISTS idx_run_node_spans_run_node ON run_node_spans (run_id, node_id)`)
  }
}
