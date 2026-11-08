import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { makeJournalWriter } from '../journal-writer.js'
import { allocRunLiveSeq, forRunLive, resetRunLiveForTest } from '../run-live-registry.js'
import {
  findDecision,
  findDecisions,
  listEventFrames,
  hasJournalRows,
} from '../repositories/run-node-journal.repo.js'

/**
 * journal-writer 写侧单点（design-recover §⑥ AC-R7-2 的 writer 面 + §3.4(b)）：
 *  - decision 行：recordDecision → findDecision 读回（payload 形状全量）；
 *    迭代控制器 onNodeEnd 二次触发 → (nodeId, ordinal) 幂等 upsert（AC-R1-2
 *    「每 (nodeId, ordinal) 一档」的写侧钉子）。
 *  - 结构帧 write-through：captureStructural → event 行（nodeEnd 带 ordinal、
 *    runEnd 的 node_id='__run__'、payload=帧原样含 at/seq）。
 *  - delta write-behind：captureDelta 微批缓冲 + close() flush（§3.4(b)）。
 *  - 单 run 保护性上限（NFR-7）：超限 delta 拒收 + journal_overflow 留痕行。
 * 真库 dagents_gw_test（globalSetup 自动迁移——journal 表/索引链同批实证）。
 */

const FLOW_ID = '00000000-0000-4000-8000-00000000c001'
const runIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  assertTestDatabase(AppDataSource)
  await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(
    () => {},
  )
  resetRunLiveForTest()
})

/** 注册清理的 runId 生成（journal 表无硬 FK——UUID 即可）。 */
function mkRun(): string {
  const runId = crypto.randomUUID()
  runIds.push(runId)
  return runId
}

async function mkWriter(runId: string) {
  // forRunLive 创建 entry（seq 计数器的宿主）——writer 的 allocSeq 与帧取号
  // 同一计数器（AD-R5 单写者）。
  forRunLive(runId, FLOW_ID)
  return makeJournalWriter({
    runId,
    flowId: FLOW_ID,
    allocSeq: () => allocRunLiveSeq(runId),
  })
}

/** 轮询等待串行链落库（write-through/write-behind 均异步）。 */
async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('journal-writer：decision 行（R1 真相源写侧）', () => {
  it('recordDecision → findDecision 读回（status/inputHash/output/lineage/resolvedModel 全量）', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    writer.recordDecision({
      nodeId: 'nA',
      ordinal: 0,
      status: 'done',
      inputHash: 'a'.repeat(40),
      output: { content: '产出' },
      tokens: { inputTokens: 3, outputTokens: 5 },
      resolvedModel: 'cli:claude',
    })
    await until(async () => (await findDecision(runId, 'nA', 0)) != null)
    const row = await findDecision(runId, 'nA', 0)
    expect(row?.payload.status).toBe('done')
    expect(row?.payload.inputHash).toBe('a'.repeat(40))
    expect(row?.payload.output).toEqual({ content: '产出' })
    expect(row?.payload.tokens).toEqual({ inputTokens: 3, outputTokens: 5 })
    expect(row?.payload.resolvedModel).toBe('cli:claude')
  })

  it('cached decision 携带 lineage（暖缓存/续跑谱系标注，§3.1(c)2）', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    writer.recordDecision({
      nodeId: 'nB',
      ordinal: 0,
      status: 'cached',
      inputHash: 'b'.repeat(40),
      lineage: { inheritedFromRunId: '00000000-0000-4000-8000-00000000c100' },
    })
    await until(async () => (await findDecision(runId, 'nB', 0)) != null)
    const row = await findDecision(runId, 'nB', 0)
    expect(row?.payload.status).toBe('cached')
    expect(row?.payload.lineage).toEqual({
      inheritedFromRunId: '00000000-0000-4000-8000-00000000c100',
    })
  })

  it('幂等 upsert（AC-R1-2 写侧）：迭代控制器二次触发同 (nodeId, ordinal) 仍一行、payload 覆盖', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    writer.recordDecision({ nodeId: 'iter', ordinal: 0, status: 'done', output: { v: 1 } })
    writer.recordDecision({ nodeId: 'iter', ordinal: 0, status: 'done', output: { v: 2 } })
    await until(async () => {
      const rows = await findDecisions(runId)
      const hit = rows.find((r) => r.nodeId === 'iter')
      return hit != null && (hit.payload.output as { v?: number })?.v === 2
    })
    const rows = await findDecisions(runId)
    expect(rows.filter((r) => r.nodeId === 'iter')).toHaveLength(1)
    expect(rows[0]!.payload.output).toEqual({ v: 2 })
  })

  it('per-ordinal 多档并存（迭代 body 第 n 次执行各一档，AC-R1-2）', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    for (let i = 0; i < 3; i++) {
      writer.recordDecision({ nodeId: 'body', ordinal: i, status: 'done', output: { i } })
    }
    await until(async () => (await findDecisions(runId)).length >= 3)
    const rows = await findDecisions(runId)
    expect(rows.map((r) => r.ordinal).sort()).toEqual([0, 1, 2])
  })

  it('lookup（引擎 JournalFacade 查询腿）返回 null/命中两态', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    expect(await writer.lookup('none', 0)).toBeNull()
    writer.recordDecision({ nodeId: 'nL', ordinal: 0, status: 'done', output: { ok: 1 } })
    await until(async () => (await writer.lookup('nL', 0)) != null)
    const found = await writer.lookup('nL', 0)
    expect(found?.status).toBe('done')
    expect(found?.output).toEqual({ ok: 1 })
  })
})

describe('journal-writer：结构帧 write-through（R7 §3.4(b)）', () => {
  it('captureStructural → event 行：nodeEnd 带 ordinal、runEnd 的 node_id=__run__、payload 原样含 seq', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    const nodeEnd = writer.captureStructural({
      type: 'nodeEnd',
      nodeId: 'nE',
      nodeName: 'E',
      status: 'done',
      ordinal: 2,
      at: '2026-10-07T01:00:00.000Z',
      seq: allocRunLiveSeq(runId),
    })
    await nodeEnd
    await writer.captureStructural({
      type: 'runEnd',
      status: 'stopped',
      stopReason: 'user',
      at: '2026-10-07T01:00:01.000Z',
      seq: allocRunLiveSeq(runId),
    })
    await until(async () => {
      const { frames } = await listEventFrames(runId)
      return frames.length >= 2
    })
    const { frames, flowId } = await listEventFrames(runId)
    expect(flowId).toBe(FLOW_ID)
    const nodeEndRow = frames.find((f) => f.eventType === 'nodeEnd')
    expect(nodeEndRow?.nodeId).toBe('nE')
    expect((nodeEndRow?.frame as { ordinal?: number }).ordinal).toBe(2)
    expect(typeof (nodeEndRow?.frame as { seq?: number }).seq).toBe('number')
    const runEndRow = frames.find((f) => f.eventType === 'runEnd')
    expect(runEndRow?.nodeId).toBe('__run__')
    expect((runEndRow?.frame as { stopReason?: string }).stopReason).toBe('user')
    // seq 升序交付（回放顺序依据）
    const seqs = frames.map((f) => f.seq)
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b))
  })
})

describe('journal-writer：delta write-behind + 上限拒收（NFR-7）', () => {
  it('captureDelta 微批缓冲 + close() flush → event 行（eventType=delta）', async () => {
    const runId = mkRun()
    const writer = await mkWriter(runId)
    for (let i = 0; i < 3; i++) {
      writer.captureDelta({
        type: 'delta',
        nodeId: 'nD',
        nodeName: 'D',
        delta: { type: 'text', text: `t${i}` },
        at: '2026-10-07T02:00:00.000Z',
        seq: allocRunLiveSeq(runId),
      })
    }
    // 微批窗口未满（<64 条 / <200ms）——close 强制 flush
    writer.close()
    await until(async () => {
      const { frames } = await listEventFrames(runId)
      return frames.filter((f) => f.eventType === 'delta').length >= 3
    })
    const { frames } = await listEventFrames(runId)
    expect(frames.filter((f) => f.eventType === 'delta')).toHaveLength(3)
    expect(hasJournalRows(runId)).resolves.toBe(true)
  })

  it('单 run 上限：超限后 delta 拒收 + journal_overflow 留痕行（不静默丢）', async () => {
    const runId = mkRun()
    process.env.DAGENTS_JOURNAL_MAX_ROWS_PER_RUN = '2'
    try {
      const writer = await mkWriter(runId)
      // 2 行内照收（上限按 writer 的 rows 计数：decision/结构/delta 总行数）
      writer.recordDecision({ nodeId: 'cap', ordinal: 0, status: 'done', output: {} })
      await until(async () => (await findDecision(runId, 'cap', 0)) != null)
      writer.captureDelta({
        type: 'delta',
        nodeId: 'cap',
        nodeName: 'cap',
        delta: { type: 'text', text: 'in-cap' },
        at: '2026-10-07T03:00:00.000Z',
        seq: allocRunLiveSeq(runId),
      })
      // 第 3 行起：超限 → 拒收 + overflow 留痕（event_type='journal_overflow'）
      writer.captureDelta({
        type: 'delta',
        nodeId: 'cap',
        nodeName: 'cap',
        delta: { type: 'text', text: 'over-cap' },
        at: '2026-10-07T03:00:01.000Z',
        seq: allocRunLiveSeq(runId),
      })
      await until(async () => {
        const { frames } = await listEventFrames(runId)
        return frames.some((f) => f.eventType === 'journal_overflow')
      })
      const { frames } = await listEventFrames(runId)
      const overflow = frames.find((f) => f.eventType === 'journal_overflow')
      expect((overflow?.frame as { rejectedDeltaFrames?: number }).rejectedDeltaFrames).toBe(1)
      // 超限后的正文 delta 不落库（拒收面）
      expect(frames.some((f) => (f.frame as { delta?: { text?: string } }).delta?.text === 'over-cap')).toBe(false)
    } finally {
      delete process.env.DAGENTS_JOURNAL_MAX_ROWS_PER_RUN
    }
  })
})
