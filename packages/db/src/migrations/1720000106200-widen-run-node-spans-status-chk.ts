import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 放宽 run_node_spans.status 的 CHECK 约束（2026-10-07 可恢复性/工程决策/
 * 渐进产物三方向共同前置——总架构师评审裁决，design-sharp §1.2 持有范式）。
 *
 * 建表迁移即带五值 CHECK（1720000007000:57-58），此后无迁移触碰。三个方向
 * 的写库将被旧 CHECK 拒收：boot sweep 写 `'stopped'`（design-recover §3.2②）、
 * 暖缓存 cached span 落库（design-recover §3.1(c)2）、试运行上限拒绝语义
 * `'rejected'`（design-sharp 9d）——且 boot sweep 每步独立容错会吞错、spans
 * 永悬 running，正是 1720000103000:4-9 头注释记载的实弹故障模式。
 *
 * 一次放宽到位三词（分三次 = 三次全表扫描 + 三轮合并协调）；词表是放宽非
 * 收紧（旧值全保留），ADD CONSTRAINT 默认 VALID 扫全表必过。down 恢复五值
 * 窄表——存量新词行存在时会失败（down 是逃生门不是往返保证，仓库既有范式）。
 */
export class WidenRunNodeSpansStatusChk1720000106200 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE "run_node_spans" DROP CONSTRAINT IF EXISTS run_node_spans_status_chk`,
    )
    await qr.query(`
      ALTER TABLE "run_node_spans"
        ADD CONSTRAINT run_node_spans_status_chk
        CHECK ("status" IN ('running','done','failed','paused','unknown','rejected','cached','stopped'))
    `)
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE "run_node_spans" DROP CONSTRAINT IF EXISTS run_node_spans_status_chk`,
    )
    await qr.query(`
      ALTER TABLE "run_node_spans"
        ADD CONSTRAINT run_node_spans_status_chk
        CHECK ("status" IN ('running','done','failed','paused','unknown'))
    `)
  }
}
