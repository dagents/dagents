/**
 * 执行轨迹保留策略（2026-09-06 单机还债）：runs / run_node_spans /
 * dispatch_task_events 是可再生的执行轨迹（聊天内容、flow 配置永不清理），
 * events 全量通道上线后 spans 的 JSONB 单行可达 ~1MB —— 无限增长会让
 * 本机库慢慢变沉。按 `DAGENTS_RETENTION_DAYS`（默认 90 天）定期清理：
 *
 *   - 删除 finished_at 早于窗口的 runs（spans / dispatch_task_events 经
 *     run_id 外键或显式删除级联跟随；无外键的按 run_id 手动删）；
 *   - orphan spans / task events（run 行已缺失）一并回收；
 *   - 仍处非终态的 run 不动（boot sweep 才是它们的归宿）。
 *
 * 单机个人工具的取舍：不做分区/归档表，直接删 —— 终态执行轨迹对个人的
 * 价值随时间指数衰减，90 天足够回看；要长期留档请调 env 或定期 pg_dump
 * （scripts/backup.sh）。
 */
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:retention' })

/** 0 或负数 = 关闭保留清理。 */
export const RETENTION_DAYS = Number(process.env.DAGENTS_RETENTION_DAYS ?? 90)

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 跑一轮保留清理，返回删除的 run 行数（测试/手动调用用）。 */
export async function runRetentionSweep(now = new Date()): Promise<number> {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) return 0
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  // 先删轨迹子表（run_node_spans 有 (run_id) 外键与否不确定 —— 显式删最稳），
  // 再删 runs 行；两者都限定在窗口内的终态 run。
  const { records } = await runQuery<{ id: string }>(
    `SELECT id FROM runs
      WHERE created_at < $1
        AND status IN ('completed', 'failed', 'cancelled')`,
    [cutoff.toISOString()],
  )
  if (records.length === 0) return 0
  const ids = records.map((r) => r.id)
  await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [ids])
  await runQuery(`DELETE FROM dispatch_task_events WHERE task_id IN (
      SELECT id FROM dispatch_tasks WHERE run_id = ANY($1::text[])
    )`, [ids])
  await runQuery(`DELETE FROM dispatch_tasks WHERE run_id = ANY($1::text[])`, [ids])
  const { affected } = await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [ids])

  // orphan 轨迹（run 行已不存在）一并回收
  await runQuery(`DELETE FROM run_node_spans WHERE run_id NOT IN (SELECT id FROM runs)`)
  await runQuery(`DELETE FROM dispatch_tasks WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs)`)

  log.info('retention sweep', { deletedRuns: affected ?? ids.length, cutoff: cutoff.toISOString() })
  return affected ?? ids.length
}

/** 挂载每日保留清理（boot 立即跑一轮 + 24h 间隔）。 */
export function startRetentionTimer(): void {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) {
    log.info('retention disabled (DAGENTS_RETENTION_DAYS <= 0)')
    return
  }
  void runRetentionSweep().catch((err: unknown) => {
    log.warn('retention sweep failed', { error: String(err) })
  })
  const timer = setInterval(() => {
    void runRetentionSweep().catch((err: unknown) => {
      log.warn('retention sweep failed', { error: String(err) })
    })
  }, SWEEP_INTERVAL_MS)
  timer.unref?.()
}
