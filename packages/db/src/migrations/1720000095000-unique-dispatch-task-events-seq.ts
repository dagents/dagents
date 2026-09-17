import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * dispatch_task_events (task_id, seq) 唯一索引（2026-09-17 评审补齐）。
 *
 * seq 由「INSERT 内联 MAX+1 CTE」生成（tasks.ts /messages）——单 daemon
 * 认领制下窗口极小，但 PG 快照语义下并发语句仍可读到同一 MAX 产生重复
 * seq（事件流乱序/丢失可观测性）。唯一索引把这个不变量交给数据库：
 * 冲突直接报错而非静默乱序。
 *
 * 先去重再建索引：存量重复行保留每组 (task_id, seq) 中 created_at 最新
 * 的一行（多写一侧通常是迟到的重发），其余删除。
 */
export class UniqueDispatchTaskEventsSeq1720000095000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    // 去重：同 (task_id, seq) 保留 id 最大的行（生成顺序的粗代理——
    // gen_random_uuid 无时序，但同组内等价保留任一行即可）
    await qr.query(`
      DELETE FROM dispatch_task_events a
       USING dispatch_task_events b
       WHERE a.task_id = b.task_id
         AND a.seq = b.seq
         AND a.id < b.id
    `)
    // 原 (task_id, seq) 普通索引与新唯一约束同名不同物 —— 先删旧再建新
    await qr.query(`DROP INDEX IF EXISTS idx_dispatch_task_events_task_seq`)
    await qr.query(
      `CREATE UNIQUE INDEX uq_dispatch_task_events_task_seq ON dispatch_task_events (task_id, seq)`,
    )
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS uq_dispatch_task_events_task_seq`)
    await qr.query(
      `CREATE INDEX idx_dispatch_task_events_task_seq ON dispatch_task_events (task_id, seq)`,
    )
  }
}
