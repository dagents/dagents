import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { sweepDanglingExecutions } from '../boot-sweep.js'

/**
 * Boot sweep 三件收敛（2026-10-07 可恢复性地基，design-recover §3.2 / AC-R3-1）：
 * 真实 DB（dagents_gw_test 由 globalSetup 迁移——本套同时实证迁移链落地：
 * 1720000111000 的 stop_reason 列、1720000106200 的 spans CHECK 放宽、
 * 1720000110000 的 journal 表与部分唯一索引）：
 *  ① runs 在途行 → (stopped, interrupted)；② 悬空 running span → stopped；
 *  ③ 悬空 running checkpoint → resumable。终态行零改写（AC-R3-1）。
 */

const FLOW_ID = '00000000-0000-4000-8000-00000000b001'
const RUN_STOPPED = '00000000-0000-4000-8000-00000000b101'
const RUN_PENDING = '00000000-0000-4000-8000-00000000b102'
const RUN_FAILED = '00000000-0000-4000-8000-00000000b103'
const RUN_SPANS = '00000000-0000-4000-8000-00000000b201'
const RUN_CKPT = '00000000-0000-4000-8000-00000000b301'
const CKPT_TERMINAL_RUN = '00000000-0000-4000-8000-00000000b302'
const RUN_JOURNAL = '00000000-0000-4000-8000-00000000b401'
const ALL_RUN_IDS = [
  RUN_STOPPED,
  RUN_PENDING,
  RUN_FAILED,
  RUN_SPANS,
  RUN_CKPT,
  CKPT_TERMINAL_RUN,
  RUN_JOURNAL,
]

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  const ids = ALL_RUN_IDS.map((id) => id)
  await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [ids]).catch(
    () => {},
  )
  await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [ids]).catch(() => {})
  await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [ids]).catch(
    () => {},
  )
  await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {})
})

async function insertRun(id: string, status: string): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, '{}', NOW())`,
    [id, id, FLOW_ID, status],
  )
}

async function insertSpan(runId: string, nodeId: string, status: string): Promise<void> {
  await runQuery(
    `INSERT INTO run_node_spans (run_id, flow_id, node_id, status, started_at)
     VALUES ($1::uuid, $2::text, $3, $4, NOW())`,
    [runId, FLOW_ID, nodeId, status],
  )
}

async function insertCheckpoint(runId: string, status: string): Promise<void> {
  await runQuery(
    `INSERT INTO run_checkpoints (run_id, flow_id, status, topo_hash, snapshot)
     VALUES ($1::uuid, $2::uuid, $3, 'seed', '{}')`,
    [runId, FLOW_ID, status],
  )
}

describe('boot sweep 三件收敛 → stopped(interrupted)', () => {
  it('① 在途 runs（running/pending）→ stopped + stop_reason=interrupted；终态行零改写', async () => {
    await insertRun(RUN_STOPPED, 'running')
    await insertRun(RUN_PENDING, 'pending')
    await insertRun(RUN_FAILED, 'failed')

    await sweepDanglingExecutions()

    const { records } = await runQuery<RunRow>(
      `SELECT id, status, stop_reason FROM runs WHERE id = ANY($1::uuid[])`,
      [ALL_RUN_IDS.slice(0, 3)],
    )
    const byId = new Map(records.map((r) => [r.id, r]))
    // 在途行：stopped(interrupted) —— 中断事实诚实，区别于真失败
    expect(byId.get(RUN_STOPPED)).toMatchObject({ status: 'stopped', stop_reason: 'interrupted' })
    expect(byId.get(RUN_PENDING)).toMatchObject({ status: 'stopped', stop_reason: 'interrupted' })
    // 终态行零改写（AC-R3-1）：failed 保持 failed、stop_reason NULL
    expect(byId.get(RUN_FAILED)).toMatchObject({ status: 'failed', stop_reason: null })
  })

  it('② 悬空 running span → stopped（error/finished_at 兜底）；终态 span 不动', async () => {
    await insertRun(RUN_SPANS, 'running')
    await insertSpan(RUN_SPANS, 'n1', 'running')
    await insertSpan(RUN_SPANS, 'n2', 'done')
    await insertSpan(RUN_SPANS, 'n3', 'failed')

    await sweepDanglingExecutions()

    const { records } = await runQuery<{ node_id: string; status: string; error: string | null }>(
      `SELECT node_id, status, error FROM run_node_spans WHERE run_id = $1::uuid ORDER BY node_id`,
      [RUN_SPANS],
    )
    const byNode = new Map(records.map((r) => [r.node_id, r]))
    expect(byNode.get('n1')?.status).toBe('stopped')
    expect(byNode.get('n1')?.error).toContain('boot sweep')
    expect(byNode.get('n2')?.status).toBe('done')
    expect(byNode.get('n3')?.status).toBe('failed')
  })

  it('③ 悬空 running checkpoint → resumable（resume 路由闸门不再 409）；terminal 不改写', async () => {
    await insertRun(RUN_CKPT, 'running')
    await insertRun(CKPT_TERMINAL_RUN, 'completed')
    await insertCheckpoint(RUN_CKPT, 'running')
    await insertCheckpoint(CKPT_TERMINAL_RUN, 'terminal')

    await sweepDanglingExecutions()

    const { records } = await runQuery<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`,
      [[RUN_CKPT, CKPT_TERMINAL_RUN]],
    )
    const byRun = new Map(records.map((r) => [r.run_id, r.status]))
    expect(byRun.get(RUN_CKPT)).toBe('resumable')
    expect(byRun.get(CKPT_TERMINAL_RUN)).toBe('terminal') // 终态单向门不改写
  })

  it('迁移链词表事实核验：cached/stopped span 可写、journal 表与 decision 部分唯一索引在位', async () => {
    // 1720000106200 放宽后 'cached'/'stopped' 直接 INSERT 不被 CHECK 拒收；
    // 1720000110000 的 journal 表可写且 (run_id, node_id, ordinal) WHERE
    // kind='decision' 部分唯一索引兜底二写。
    await insertRun(RUN_JOURNAL, 'stopped')
    await insertSpan(RUN_JOURNAL, 'n1', 'cached')
    await insertSpan(RUN_JOURNAL, 'n2', 'stopped')
    await runQuery(
      `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, payload)
       VALUES ($1::uuid, $2::text, 'n1', 0, 'decision', 1, '{}'),
              ($1::uuid, $2::text, '__run__', 0, 'event', 2, '{}')`,
      [RUN_JOURNAL, FLOW_ID],
    )
    const { records } = await runQuery<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM run_node_journal WHERE run_id = $1::uuid`,
      [RUN_JOURNAL],
    )
    expect(records[0]?.cnt).toBe('2')

    const dup = await runQuery(
      `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, payload)
       VALUES ($1::uuid, $2::text, 'n1', 0, 'decision', 3, '{}')`,
      [RUN_JOURNAL, FLOW_ID],
    ).then(
      () => 'inserted',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(dup).toContain('duplicate key') // uq_run_node_journal_decision
  })
})

interface RunRow {
  id: string
  status: string
  stop_reason: string | null
}
