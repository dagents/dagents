import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { runLineageChain, lineageTokensSpent, LINEAGE_MAX_DEPTH } from '../lineage.js'

/**
 * 谱系链共享 helper（design-recover §3.7(b)1，§⑥）：
 *  - runLineageChain：沿 resumed_from_run_id 溯源、返回自根向后代（含自身）；
 *    深度上限 16（评审定稿——R6/本方向共用单源）；断链 = 停在断点（前驱被
 *    retention 清掉 → 不进候选，诚实 miss R2.6）。
 *  - lineageTokensSpent：usage_events 按链 SUM（R3.4 预算黄警 / R2 双口径）。
 * 真库 dagents_gw_test（globalSetup）。
 */

const createdRunIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  assertTestDatabase(AppDataSource)
  await runQuery(`DELETE FROM usage_events WHERE run_id = ANY($1::uuid[])`, [
    createdRunIds,
  ]).catch(() => {})
  await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [createdRunIds]).catch(() => {})
})

function mkRunId(): string {
  const id = crypto.randomUUID()
  createdRunIds.push(id)
  return id
}

/** 插一行 runs（可带谱系指针）。 */
async function insertRun(runId: string, resumedFrom: string | null): Promise<void> {
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at, resumed_from_run_id)
     VALUES ($1::uuid, $1::text, '00000000-0000-4000-8000-0000000000aa', 'completed', '{}'::jsonb, NOW(), $2::uuid)
     ON CONFLICT (id) DO NOTHING`,
    [runId, resumedFrom],
  )
}

describe('runLineageChain（谱系链单源）', () => {
  it('三级链：自根向后代（含自身在末位），最近 = 数组末尾往前', async () => {
    const root = mkRunId()
    const mid = mkRunId()
    const leaf = mkRunId()
    await insertRun(root, null)
    await insertRun(mid, root)
    await insertRun(leaf, mid)
    const chain = await runLineageChain(leaf)
    expect(chain).toEqual([root, mid, leaf])
  })

  it('根运行（无谱系）：链 = [自身]', async () => {
    const root = mkRunId()
    await insertRun(root, null)
    expect(await runLineageChain(root)).toEqual([root])
  })

  it('断链（中间前驱被 retention 清掉）：查不到的 run 不进候选，链停在断点（诚实 miss，R2.6）', async () => {
    // root 存在但 mid 被删：leaf → mid（查无此行）→ ghost 不进链，链 = [leaf]
    const root = mkRunId()
    const ghost = mkRunId() // 只登记清理、不插行（被 retention 清掉的前驱）
    const leaf = mkRunId()
    await insertRun(root, null)
    await insertRun(leaf, ghost)
    const chain = await runLineageChain(leaf)
    expect(chain).toEqual([leaf])
    void root
  })

  it(`深度上限 ${LINEAGE_MAX_DEPTH}：超长链截断（防环护栏同款上限）`, async () => {
    expect(LINEAGE_MAX_DEPTH).toBe(16)
    // 17 级链：root ← c1 ← ... ← c16（c16 是查询入口）
    const ids: string[] = []
    for (let i = 0; i < 17; i++) ids.push(mkRunId())
    await insertRun(ids[0]!, null)
    for (let i = 1; i < ids.length; i++) await insertRun(ids[i]!, ids[i - 1]!)
    const chain = await runLineageChain(ids[16]!)
    expect(chain).toHaveLength(16)
    expect(chain[chain.length - 1]).toBe(ids[16]!)
    // 最老的 root 被截掉（上限语义：停在最近 16 跳）
    expect(chain[0]).toBe(ids[1]!)
  })

  it('不存在的 run → 空链（整链 miss，调用方按零候选全量重跑）', async () => {
    const ghost = mkRunId()
    expect(await runLineageChain(ghost)).toEqual([])
  })
})

describe('lineageTokensSpent（谱系累计 token）', () => {
  it('按链 SUM usage_events 的 inputTokens+outputTokens；无记账返回 0', async () => {
    const root = mkRunId()
    const mid = mkRunId()
    const leaf = mkRunId()
    await insertRun(root, null)
    await insertRun(mid, root)
    await insertRun(leaf, mid)
    for (const [runId, input, output] of [
      [root, 100, 50],
      [mid, 30, 20],
      [leaf, 5, 5],
    ] as const) {
      await runQuery(
        `INSERT INTO usage_events (id, source, run_id, usage, priced)
         VALUES ($1::uuid, 'workflow_run', $2::uuid, $3::jsonb, false)`,
        [crypto.randomUUID(), runId, JSON.stringify({ inputTokens: input, outputTokens: output })],
      )
    }
    const total = await lineageTokensSpent([root, mid, leaf])
    expect(total).toBe(210)
    // 空链 / 查询失败路径（不存在的 run 无 usage 行）
    expect(await lineageTokensSpent([])).toBe(0)
    expect(await lineageTokensSpent([crypto.randomUUID()])).toBe(0)
  })
})
