/**
 * buildResumeSeed 单测（design-recover §3.5(a)，R1 journal 化种子）：
 * 真实 DB（dagents_gw_test）钉「journal decision 行 → ResumeOptions」的
 * 组装映射——§⑥ 测试计划的「老 run（无 journal/hash）resume 行为不劣于
 * 现状（checkpoint 兜底路径单测）」即 AC-R1-5 的路由侧：
 *  - journal 化种子：ordinal=0 done/cached 行进 seedOutputs + seedHashes；
 *    迭代 body 的 ordinal>=1 行组装 itemNodeOutputs（per-ordinal 种子，
 *    AC-R1-2）；控制器节点不种子化（既有裁决：控制器重跑 planning）；
 *    seedSource={kind:'resume', fromRunId}；
 *  - checkpoint 兜底（AC-R1-5）：无 journal 行的老 run 回落 snapshot 种子，
 *    无 seedHashes（引擎跳过校验照旧种子化，PRD R1.7）；
 *  - 无 checkpoint → null（路由 404 语义）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { buildResumeSeed } from '../routes/resume-execution.js'

const FLOW_ID = '00000000-0000-4000-8000-00000000d001'
const RUN_JOURNAL = '00000000-0000-4000-8000-00000000d101'
const RUN_LEGACY = '00000000-0000-4000-8000-00000000d102'
const RUN_MISSING = '00000000-0000-4000-8000-00000000d103'
const ALL_RUNS = [RUN_JOURNAL, RUN_LEGACY, RUN_MISSING]

/** 含迭代控制器的三节点图（控制器 + body + 普通下游）。 */
const FLOW_DATA = {
  nodes: [
    { id: 'iter1', type: 'customNode', data: { name: 'iterationAgentflow', label: 'Iter' } },
    { id: 'body1', type: 'customNode', data: { name: 'llmAgentflow', label: 'Body' } },
    { id: 'tail1', type: 'customNode', data: { name: 'llmAgentflow', label: 'Tail' } },
  ],
  edges: [
    { id: 'e1', source: 'iter1', target: 'body1' },
    { id: 'e2', source: 'body1', target: 'tail1' },
  ],
}

async function insertCheckpoint(
  runId: string,
  status: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await runQuery(
    `INSERT INTO run_checkpoints (run_id, flow_id, status, topo_hash, snapshot)
     VALUES ($1::uuid, $2::uuid, $3, 'topo-x', $4::jsonb)`,
    [runId, FLOW_ID, status, JSON.stringify(snapshot)],
  )
}

async function insertDecision(
  runId: string,
  nodeId: string,
  ordinal: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const { records } = await runQuery<{ next: string }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_node_journal WHERE run_id = $1::uuid`,
    [runId],
  )
  await runQuery(
    `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, payload)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'decision', $5, $6::jsonb)`,
    [runId, FLOW_ID, nodeId, ordinal, Number(records[0]!.next), JSON.stringify(payload)],
  )
}

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)

  // ── journal 化种子场景 ──
  await insertCheckpoint(RUN_JOURNAL, 'resumable', {
    outputs: { stale: { content: 'snapshot-stale' } },
    runtime: { humanInputs: {} },
    iterationProgress: {
      iter1: { completed: 1, itemOutputs: [{ content: 'item-0' }] },
    },
  })
  await insertDecision(RUN_JOURNAL, 'tail1', 0, {
    status: 'done',
    inputHash: 'hash-tail',
    output: { content: 'tail-out' },
    // 前驱 token 用量（PRD R2.3）：cached span.tokens 记继承值的数据源。
    tokens: { inputTokens: 120, outputTokens: 80, total_tokens: 200 },
  })
  await insertDecision(RUN_JOURNAL, 'body1', 0, {
    status: 'done',
    inputHash: 'hash-body-0',
    output: { content: 'body-0' },
  })
  // 迭代 body 第 1 项（断点项）：per-ordinal 种子（i=1 的 body 输出）
  await insertDecision(RUN_JOURNAL, 'body1', 1, {
    status: 'done',
    output: { content: 'body-1' },
  })
  // cached 行（暖缓存/续跑种子）也进种子；failed 行不进
  await insertDecision(RUN_JOURNAL, 'body1', 2, {
    status: 'cached',
    output: { content: 'body-2-cached' },
  })
  await insertDecision(RUN_JOURNAL, 'body1', 3, {
    status: 'failed',
    output: { content: 'failed-not-seeded' },
  })
  // 控制器行在场——既有裁决：控制器不种子化（重跑 planning）
  await insertDecision(RUN_JOURNAL, 'iter1', 0, {
    status: 'done',
    output: { iterations: [] },
  })

  // ── 老 run 兜底场景（迁移前失败存量，无 journal 行）──
  await insertCheckpoint(RUN_LEGACY, 'resumable', {
    outputs: { tail1: { content: 'legacy-tail' }, iter1: { iterations: [] } },
    runtime: { seedFlag: true },
    iterationProgress: {},
  })
})

afterAll(async () => {
  await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [ALL_RUNS]).catch(
    () => {},
  )
  await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [ALL_RUNS]).catch(
    () => {},
  )
})

describe('buildResumeSeed（R1 journal 化种子，§3.5(a)）', () => {
  it('journal 行组装：done/cached 进 seedOutputs + seedHashes；failed 不进；控制器排除', async () => {
    const seed = await buildResumeSeed(RUN_JOURNAL, FLOW_DATA)
    expect(seed).not.toBeNull()
    // ordinal=0 行 → 根图种子（journal 优先于 snapshot 的 stale 输出）
    expect(seed!.seedOutputs['tail1']).toEqual({ content: 'tail-out' })
    expect(seed!.seedOutputs['body1']).toEqual({ content: 'body-0' })
    // snapshot 的 stale 输出被 journal 行替代（AD-R2 真相源）
    expect(seed!.seedOutputs['stale']).toBeUndefined()
    // seedHashes 逐节点携带（引擎跳过前预演对账，AC-R1-3 数据面）
    expect(seed!.seedHashes).toMatchObject({ tail1: 'hash-tail', body1: 'hash-body-0' })
    // seedTokens（PRD R2.3，2026-10-08 修复）：decision 行的 payload.tokens
    // 随种子传引擎——cached nodeEnd.tokens 记继承值 + lineage.inheritedTokens。
    expect(seed!.seedTokens).toMatchObject({
      tail1: { total_tokens: 200 },
    })
    // 控制器不种子化（迭代机制不被旁路）
    expect(seed!.seedOutputs['iter1']).toBeUndefined()
    // seedSource 标注（cached 钩子/journal lineage 载荷用）
    expect(seed!.seedSource).toEqual({ kind: 'resume', fromRunId: RUN_JOURNAL })
  })

  it('迭代 per-ordinal 种子：ordinal>=1 的 done/cached 行组装 itemNodeOutputs（AC-R1-2）', async () => {
    const seed = await buildResumeSeed(RUN_JOURNAL, FLOW_DATA)
    const progress = seed!.iterationProgress?.['iter1']
    expect(progress).toBeDefined()
    // 游标 completed 仍从 checkpoint snapshot（journal 行没有项完成度语义）
    expect(progress!.completed).toBe(1)
    expect(progress!.itemOutputs).toEqual([{ content: 'item-0' }])
    // [i][nodeId] = output：断点项 body 预填（done 与 cached 都进，failed 不进）
    expect(progress!.itemNodeOutputs).toEqual([
      undefined, // ordinal 0 占位（根图种子，不在 per-ordinal 载荷）
      { body1: { content: 'body-1' } },
      { body1: { content: 'body-2-cached' } },
    ])
  })

  it('checkpoint 兜底（AC-R1-5）：无 journal 行的老 run 回落 snapshot 种子、无 seedHashes', async () => {
    const seed = await buildResumeSeed(RUN_LEGACY, FLOW_DATA)
    expect(seed).not.toBeNull()
    expect(seed!.seedOutputs['tail1']).toEqual({ content: 'legacy-tail' })
    // 控制器在 snapshot outputs 里也照旧排除
    expect(seed!.seedOutputs['iter1']).toBeUndefined()
    expect(seed!.seedRuntime).toEqual({ seedFlag: true })
    // 无 hash → 引擎跳过校验照旧种子化（PRD R1.7，行为不劣于今天）
    expect(seed!.seedHashes).toBeUndefined()
    expect(seed!.seedSource).toBeUndefined()
  })

  it('无 checkpoint → null（resume 路由 404 语义不变）', async () => {
    expect(await buildResumeSeed(RUN_MISSING, FLOW_DATA)).toBeNull()
  })
})
