import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * run_node_spans (run_id, node_id) 唯一化。
 *
 * 增量进度写入（span-writer 的 UPDATE-then-INSERT）在节点毫秒级完成时存在
 * 竞态：onNodeEnd 的 UPDATE 可能先于 onNodeStart 的 INSERT 落地，导致同一
 * 节点出现两行。此迁移先清掉历史重复行（每组保留最新一行），再加唯一
 * 索引，让写入方可以走单条幂等 upsert（ON CONFLICT DO UPDATE）。
 */
export class UniqueRunNodeSpans1720000093000 implements MigrationInterface {
  name = 'UniqueRunNodeSpans1720000093000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 清重复：按 (run_id, node_id) 分组保留 created_at/started_at 最新的一行。
    // 没有 updateTime 顺序列时用 ctid 兜底（同一语句内 MAX(ctid) 稳定）。
    await queryRunner.query(`
      DELETE FROM run_node_spans a
       USING run_node_spans b
       WHERE a.run_id = b.run_id
         AND a.node_id = b.node_id
         AND a.ctid < b.ctid
    `)
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_run_node_spans_run_node" ON "run_node_spans" ("run_id", "node_id")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_run_node_spans_run_node"`)
  }
}
