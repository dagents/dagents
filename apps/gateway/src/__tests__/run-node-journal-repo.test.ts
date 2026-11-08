import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import {
  findDecisions,
  findDecision,
  findLatestDecisionByNodeAndHash,
  listEventFrames,
  hasJournalRows,
} from '../repositories/run-node-journal.repo.js'

/**
 * run-node-journal.repo 读侧单点（design-recover §3.7(b)，§⑥）：
 *  - findDecisions 的 statuses 过滤（failed 不进 resume 种子——R1.3 语义）；
 *  - findLatestDecisionByNodeAndHash：暖缓存 (nodeId, inputHash) 精确匹配 +
 *    链上最近优先（candidates 序，PRD R2.1）+ failed 行不是可复用产出；
 *  - listEventFrames：seq 升序 + 回放上限的诚实截断标记（truncatedHead）；
 *  - hasJournalRows（§3.5(c) resume 端点的 hasJournal 位）。
 * 真库 dagents_gw_test（globalSetup 自动迁移）。
 */

const createdRunIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  assertTestDatabase(AppDataSource)
  await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [
    createdRunIds,
  ]).catch(() => {})
})

function mkRunId(): string {
  const id = crypto.randomUUID()
  createdRunIds.push(id)
  return id
}

/** journal 行直插（列全量由调用方给——绕过 writer 测纯读面）。 */
async function insertJournalRow(input: {
  runId: string
  flowId: string
  nodeId: string
  ordinal?: number
  kind: 'decision' | 'event'
  seq: number
  eventType?: string | null
  payload: unknown
}): Promise<void> {
  await runQuery(
    `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, event_type, payload)
     VALUES ($1::uuid, $2::text, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.runId,
      input.flowId,
      input.nodeId,
      input.ordinal ?? 0,
      input.kind,
      input.seq,
      input.eventType ?? null,
      JSON.stringify(input.payload),
    ],
  )
}

describe('findDecisions / findDecision（R1 种子组装读面）', () => {
  it('statuses 过滤：done/cached 进种子、failed 不进（「试过且失败」入档但不复用）', async () => {
    const runId = mkRunId()
    await insertJournalRow({ runId, flowId: 'f1', nodeId: 'ok', kind: 'decision', seq: 1, payload: { status: 'done', output: { v: 1 } } })
    await insertJournalRow({ runId, flowId: 'f1', nodeId: 'warm', kind: 'decision', seq: 2, payload: { status: 'cached', output: { v: 2 } } })
    await insertJournalRow({ runId, flowId: 'f1', nodeId: 'bad', kind: 'decision', seq: 3, payload: { status: 'failed' } })
    const seedable = await findDecisions(runId, { statuses: ['done', 'cached'] })
    expect(seedable.map((r) => r.nodeId).sort()).toEqual(['ok', 'warm'])
    const all = await findDecisions(runId)
    expect(all).toHaveLength(3)
    const single = await findDecision(runId, 'bad', 0)
    expect(single?.payload.status).toBe('failed')
    expect(await findDecision(runId, 'missing', 0)).toBeNull()
  })

  it('ordinal 维度寻址：迭代 body 多档各一（AC-R1-2 读侧）', async () => {
    const runId = mkRunId()
    for (let i = 0; i < 3; i++) {
      await insertJournalRow({
        runId,
        flowId: 'f1',
        nodeId: 'body',
        ordinal: i,
        kind: 'decision',
        seq: 10 + i,
        payload: { status: 'done', output: { i } },
      })
    }
    expect((await findDecision(runId, 'body', 2))?.payload.output).toEqual({ i: 2 })
    expect(await findDecision(runId, 'body', 9)).toBeNull()
  })
})

describe('findLatestDecisionByNodeAndHash（R2 暖缓存查找）', () => {
  const HASH = 'f'.repeat(40)

  it('inputHash 精确匹配 + candidates 序即最近优先（PRD R2.1）', async () => {
    const older = mkRunId()
    const newer = mkRunId()
    const farRoot = mkRunId()
    for (const [runId, out] of [
      [farRoot, 'far'],
      [older, 'old'],
      [newer, 'new'],
    ] as const) {
      await insertJournalRow({
        runId,
        flowId: 'f1',
        nodeId: 'nX',
        kind: 'decision',
        seq: 1,
        payload: { status: 'done', inputHash: HASH, output: { which: out } },
      })
    }
    // candidates 序（链上最近在前）决定「最近」——不依赖写入时间/seq。
    const hit = await findLatestDecisionByNodeAndHash([newer, older, farRoot], 'nX', HASH)
    expect(hit?.runId).toBe(newer)
    expect(hit?.payload.output).toEqual({ which: 'new' })
    // 换序 → 换命中（序即优先级）
    const hit2 = await findLatestDecisionByNodeAndHash([older, farRoot, newer], 'nX', HASH)
    expect(hit2?.runId).toBe(older)
  })

  it('hash 不匹配 / failed 行 / 空 candidates → null（诚实 miss）', async () => {
    const runId = mkRunId()
    await insertJournalRow({ runId, flowId: 'f1', nodeId: 'nY', kind: 'decision', seq: 1, payload: { status: 'done', inputHash: '0'.repeat(40), output: {} } })
    await insertJournalRow({ runId, flowId: 'f1', nodeId: 'nZ', kind: 'decision', seq: 2, payload: { status: 'failed', inputHash: HASH } })
    expect(await findLatestDecisionByNodeAndHash([runId], 'nY', HASH)).toBeNull()
    expect(await findLatestDecisionByNodeAndHash([runId], 'nZ', HASH)).toBeNull()
    expect(await findLatestDecisionByNodeAndHash([], 'nY', HASH)).toBeNull()
  })
})

describe('listEventFrames（R7 回放读面）', () => {
  it('seq 升序交付 + 回放上限截断标记（truncatedHead，§3.4(c) 诚实截断）', async () => {
    const runId = mkRunId()
    // 倒序插入（乱序落库）——读侧按 seq 排
    for (let seq = 5; seq >= 1; seq--) {
      await insertJournalRow({
        runId,
        flowId: 'f-flow',
        nodeId: `n${seq}`,
        kind: 'event',
        seq,
        eventType: 'delta',
        payload: { type: 'delta', nodeId: `n${seq}`, seq },
      })
    }
    const full = await listEventFrames(runId)
    expect(full.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5])
    expect(full.truncatedHead).toBe(false)
    expect(full.flowId).toBe('f-flow')
    // limit=2：取最新 2 条（4,5），头部缺失标记
    const limited = await listEventFrames(runId, { limit: 2 })
    expect(limited.frames.map((f) => f.seq)).toEqual([4, 5])
    expect(limited.total).toBe(5)
    expect(limited.truncatedHead).toBe(true)
  })
})

describe('hasJournalRows（resume 端点 hasJournal 位）', () => {
  it('有行/无行两态（迁移前老 run 的兜底判据）', async () => {
    const runId = mkRunId()
    expect(await hasJournalRows(runId)).toBe(false)
    await insertJournalRow({ runId, flowId: 'f1', nodeId: 'n', kind: 'decision', seq: 1, payload: { status: 'done' } })
    expect(await hasJournalRows(runId)).toBe(true)
  })
})
