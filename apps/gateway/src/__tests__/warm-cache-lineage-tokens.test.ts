import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'
import { assertTestDatabase } from '../test-support/gw-test-db.js'

/**
 * AC-R2-3 端到端复验·常驻版（验收报告「建议后续 #1」固化）：
 * 前驱 journal tokens → warmFromRunId 暖缓存重跑 → cached span 继承
 * seedTokens + journal lineage.inheritedTokens + node-spans 信封
 * lineageTokens + usage_events 零重复记账。
 *
 * 全链走真实执行路径：gateway src 的 buildWarmCacheSeed + @dagents/workflow
 * **dist** 的引擎 seedTokens 消费段（executor 的 cached 钩子回放）。因此本套
 * 同时是 src↔dist 漂移的门禁（AGENTS.md 已知问题）：dist 陈旧（不含
 * seedTokens 消费）时 cached span tokens=null，本套红。
 *
 * 前驱 tokens 经回填而非真实 LLM 产生：directReply 流零外部依赖可真跑，
 * inputHash 由真实引擎落决策（回填仅追加 payload.tokens + usage_events
 * 记账行——对账口径与生产 LLM run 完全同源）。
 */

const TEST_TIMEOUT_MS = 60_000

const FLOW_DATA = {
  nodes: [
    { id: 'node_1', type: 'customNode', position: { x: 0, y: 300 }, data: { name: 'startAgentflow', label: 'Start' } },
    {
      id: 'node_2',
      type: 'customNode',
      position: { x: 250, y: 300 },
      data: { name: 'directReplyAgentflow', label: 'Direct Reply', content: 'warm-cache probe' },
    },
  ],
  edges: [{ id: 'edge_1_2', source: 'node_1', target: 'node_2' }],
}

const RUN_INPUT = 'ac-r2-3-probe-input'
// 前驱账面（回填）：prompt 300 + completion 200 = 500 —— 对账基准值
const PRED_TOKENS = { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 }

let flowId = ''
let predecessorRunId = ''
let warmRunId = ''

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  const runIds = [predecessorRunId, warmRunId].filter(Boolean)
  if (runIds.length) {
    const chats = await runQuery<{ chat_id: string | null }>(
      `SELECT DISTINCT chat_id FROM runs WHERE id = ANY($1::uuid[])`,
      [runIds],
    ).catch(() => ({ records: [] as Array<{ chat_id: string | null }> }))
    await runQuery(`DELETE FROM usage_events WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    const chatIds = chats.records.map((r) => r.chat_id).filter((id): id is string => id != null)
    if (chatIds.length) await runQuery(`DELETE FROM chats WHERE id = ANY($1::uuid[])`, [chatIds]).catch(() => {})
  }
  if (flowId) {
    await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [flowId]).catch(() => {})
  }
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

async function pollUntil<T>(probe: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await probe()
    if (done(v)) return v
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 同步路径跑一次 flow（directReply 微图毫秒级完成），返回 runId。 */
async function runOnce(body: Record<string, unknown>): Promise<string> {
  const res = await app.request(`/api/v1/workflows/${flowId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const headerRunId = res.headers.get('x-run-id')
  let bodyRunId: string | undefined
  try {
    bodyRunId = ((await res.json()) as { data?: { runId?: string } }).data?.runId
  } catch {
    /* 失败信封无 data —— 用头兜底，断言在下方 */
  }
  const runId = bodyRunId ?? headerRunId ?? undefined
  expect(runId, `run 应拿到 runId（status=${res.status}）`).toBeTruthy()
  return runId!
}

async function runRow(runId: string): Promise<{ status: string; resumed_from_run_id: string | null }> {
  const { records } = await runQuery<{ status: string; resumed_from_run_id: string | null }>(
    `SELECT status, resumed_from_run_id FROM runs WHERE id = $1::uuid`,
    [runId],
  )
  return records[0] ?? { status: 'missing', resumed_from_run_id: null }
}

describe('AC-R2-3 暖缓存 token 对账（端到端·含 src↔dist 漂移门禁）', () => {
  it(
    '前驱 run 真跑 → 回填 tokens/usage_events → warmFromRunId 重跑：cached span 继承 + lineage 对账 + 零重复记账',
    async () => {
      // ── 建图 ──
      const created = await app.request('/api/v1/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `warm-cache-tokens-${randomUUID().slice(0, 8)}`, flowData: FLOW_DATA }),
      })
      const flowIdFromRes = ((await created.json()) as { data?: { flow?: { id?: string } } }).data?.flow?.id
      expect(flowIdFromRes).toBeTruthy()
      flowId = flowIdFromRes!

      // ── 前驱：真实执行（journal 决策带引擎同源 inputHash）──
      predecessorRunId = await runOnce({ input: RUN_INPUT })
      const predFinal = await pollUntil(
        () => runRow(predecessorRunId),
        (r) => ['completed', 'partial_success', 'failed'].includes(r.status),
      )
      expect(predFinal.status, `前驱应成功（实际 ${predFinal.status}）`).toBe('completed')

      // 前驱决策必须已带 inputHash（暖缓存查找的匹配键——引擎 done 路径产物）
      const decisions = await pollUntil(
        () =>
          runQuery<{ payload: { status?: string; inputHash?: string } }>(
            `SELECT payload FROM run_node_journal
              WHERE run_id = $1::uuid AND kind = 'decision' AND node_id = 'node_2'`,
            [predecessorRunId],
          ),
        (r) => r.records.length > 0,
      )
      expect(decisions.records[0]?.payload.inputHash, '前驱 node_2 决策应带 inputHash').toBeTruthy()

      // 回填对账基准：决策 tokens（cached span 继承侧）+ usage_events（账单/谱系侧）
      await runQuery(
        `UPDATE run_node_journal
            SET payload = payload || $2::jsonb
          WHERE run_id = $1::uuid AND kind = 'decision' AND node_id = 'node_2'`,
        [predecessorRunId, JSON.stringify({ tokens: PRED_TOKENS })],
      )
      await runQuery(
        `INSERT INTO usage_events (id, source, run_id, usage, priced)
         VALUES ($1::uuid, 'workflow_run', $2::uuid, $3::jsonb, false)`,
        [randomUUID(), predecessorRunId, JSON.stringify({ inputTokens: 300, outputTokens: 200 })],
      )

      // ── 暖缓存重跑：同 flow 同输入 + warmFromRunId ──
      warmRunId = await runOnce({ input: RUN_INPUT, warmFromRunId: predecessorRunId })
      const warmFinal = await pollUntil(
        () => runRow(warmRunId),
        (r) => ['completed', 'partial_success', 'failed'].includes(r.status),
      )
      expect(warmFinal.status, `暖缓存 run 应成功（实际 ${warmFinal.status}）`).toBe('completed')

      // R2.1 谱系书写：暖缓存 run 指向被重跑 run（链查找域的前提）
      expect(warmFinal.resumed_from_run_id).toBe(predecessorRunId)

      // cached span 继承 seedTokens（引擎 dist 消费段——本断言即漂移门禁：
      // dist 陈旧时 tokens=null 红，先 pnpm --filter @dagents/workflow build）
      const cachedSpan = await pollUntil(
        () =>
          runQuery<{ status: string; tokens: { total_tokens?: number } | null }>(
            `SELECT status, tokens FROM run_node_spans WHERE run_id = $1::uuid AND node_id = 'node_2'`,
            [warmRunId],
          ),
        (r) => r.records.length > 0 && r.records[0]?.status !== 'running',
      )
      const span = cachedSpan.records[0]
      expect(span?.status).toBe('cached')
      expect(
        span?.tokens?.total_tokens,
        'cached span tokens 应继承前驱 decision 用量（null = dist 缺 seedTokens 消费，src↔dist 漂移）',
      ).toBe(PRED_TOKENS.total_tokens)

      // journal lineage：cached decision 带 inheritedFromRunId + inheritedTokens
      const lineageRow = await pollUntil(
        () =>
          runQuery<{ payload: { status?: string; lineage?: { inheritedFromRunId?: string; inheritedTokens?: number } } }>(
            `SELECT payload FROM run_node_journal
              WHERE run_id = $1::uuid AND kind = 'decision' AND node_id = 'node_2'`,
            [warmRunId],
          ),
        (r) => {
          const p = r.records[0]?.payload
          return p?.status === 'cached' && p.lineage?.inheritedFromRunId === predecessorRunId
        },
      )
      expect(lineageRow.records[0]?.payload.lineage?.inheritedTokens).toBe(PRED_TOKENS.total_tokens)

      // 零重复记账：暖缓存 run 自身 usage_events 计账为零（种子节点零调用）
      const { records: warmUsage } = await runQuery<{ total: string | null }>(
        `SELECT SUM(COALESCE((usage->>'inputTokens')::bigint, 0)
                    + COALESCE((usage->>'outputTokens')::bigint, 0)) AS total
           FROM usage_events WHERE run_id = $1::uuid`,
        [warmRunId],
      )
      expect(Number(warmUsage[0]?.total ?? 0)).toBe(0)

      // 口径一致：node-spans 信封 lineageTokens = 链上前驱 usage_events SUM（=500），
      // 与账单同源（lineageTokensSpent）——结果面板「谱系继承 · 本次新增」的继承侧
      const res = await app.request(`/api/v1/workflows/runs/${warmRunId}/node-spans`)
      expect(res.status).toBe(200)
      const envelope = (await res.json()) as {
        data?: { lineageTokens?: number | null; runStatus?: string; spans?: Array<{ nodeId: string; status: string; tokens?: { total_tokens?: number } | null }> }
      }
      expect(envelope.data?.lineageTokens).toBe(PRED_TOKENS.total_tokens)
      const cachedApi = envelope.data?.spans?.find((s) => s.nodeId === 'node_2')
      expect(cachedApi?.status).toBe('cached')
      expect(cachedApi?.tokens?.total_tokens).toBe(PRED_TOKENS.total_tokens)
    },
    TEST_TIMEOUT_MS,
  )
})
