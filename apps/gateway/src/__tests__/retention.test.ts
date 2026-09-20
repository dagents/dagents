import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppDataSource, runQuery } from '@dagents/db'
import { runRetentionSweep } from '../retention.js'
import { assertTestDatabase } from '../test-support/gw-test-db.js'

/**
 * retention sweep 首个测试（架构优化轮四，2026-09-20）：此前 sweep 零覆盖
 * —— 且它管的正是「可再生的执行轨迹」删不删、删不删得干净（spans /
 * checkpoints 孤儿堆积实锤过：runs 被外部清空后 10 行孤儿 checkpoint 残留）。
 *
 * 场景：窗口外终态 run（应删，连带 spans/checkpoints）、窗口内终态 run
 * （不动）、窗口外非终态 run（不动 —— boot sweep 的归宿）、孤儿
 * spans/checkpoints（run 行缺失，应回收）。
 */

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

async function seedRun(id: string, opts: { ageDays: number; status: string }): Promise<void> {
  const started = new Date(Date.now() - opts.ageDays * 86_400_000).toISOString()
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at, finished_at, duration_ms, cost, created_at)
     VALUES ($1::uuid, $1::text, $2, $3, '{}', null, $4, 5, 0, $4)`,
    [id, randomUUID(), opts.status, started],
  )
}

async function seedSpan(runId: string, nodeId: string): Promise<void> {
  await runQuery(
    `INSERT INTO run_node_spans (id, run_id, flow_id, node_id, status)
     VALUES ($1, $2::uuid, $2::uuid, $3, 'done')`,
    [randomUUID(), runId, nodeId],
  )
}

async function seedCheckpoint(runId: string): Promise<void> {
  await runQuery(
    `INSERT INTO run_checkpoints (run_id, flow_id, status, topo_hash, snapshot)
     VALUES ($1, $1, 'terminal', 'hash', '{}')`,
    [runId],
  )
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { records } = await runQuery<{ n: string }>(sql, params)
  return Number(records[0]?.n ?? 0)
}

describe('retention sweep', () => {
  it('窗口外终态 run 连带轨迹回收；窗口内/非终态不动；孤儿 spans/checkpoints 回收', async () => {
    assertTestDatabase(AppDataSource)
    const oldRun = randomUUID()
    const youngRun = randomUUID()
    const runningRun = randomUUID()
    const orphanCkptId = randomUUID()

    await seedRun(oldRun, { ageDays: 120, status: 'completed' })
    await seedRun(youngRun, { ageDays: 0, status: 'completed' })
    await seedRun(runningRun, { ageDays: 120, status: 'running' })
    await seedSpan(oldRun, 'ret-old-node')
    await seedSpan(youngRun, 'ret-young-node')
    // 孤儿 span：run_id 指向不存在的 run
    await seedSpan(randomUUID(), 'ret-orphan-node')
    await seedCheckpoint(oldRun)
    // 孤儿 checkpoint：run 行缺失
    await seedCheckpoint(orphanCkptId)

    const deleted = await runRetentionSweep(new Date())
    expect(deleted).toBeGreaterThanOrEqual(1)

    // 窗口外终态：run + 连带轨迹全没了
    expect(await count(`SELECT count(*) AS n FROM runs WHERE id = $1::uuid`, [oldRun])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM run_node_spans WHERE run_id = $1::uuid`, [oldRun])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM run_checkpoints WHERE run_id = $1::uuid`, [oldRun])).toBe(0)

    // 窗口内终态：run 与轨迹都保留
    expect(await count(`SELECT count(*) AS n FROM runs WHERE id = $1::uuid`, [youngRun])).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM run_node_spans WHERE run_id = $1::uuid`, [youngRun])).toBe(1)

    // 非终态（哪怕超窗口）：不动 —— boot sweep 的归宿
    expect(await count(`SELECT count(*) AS n FROM runs WHERE id = $1::uuid`, [runningRun])).toBe(1)

    // 孤儿轨迹：回收
    expect(await count(`SELECT count(*) AS n FROM run_node_spans WHERE node_id = 'ret-orphan-node'`)).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM run_checkpoints WHERE run_id = $1::uuid`, [orphanCkptId])).toBe(0)

    // 清理本用例残余（非终态 run 的 spans 留给 sweep 的 orphan 回收兜底）
    await runQuery(`DELETE FROM run_node_spans WHERE run_id IN ($1::uuid, $2::uuid)`, [youngRun, runningRun])
    await runQuery(`DELETE FROM run_checkpoints WHERE run_id = $1::uuid`, [youngRun])
    await runQuery(`DELETE FROM runs WHERE id IN ($1::uuid, $2::uuid)`, [youngRun, runningRun])
  })
})
