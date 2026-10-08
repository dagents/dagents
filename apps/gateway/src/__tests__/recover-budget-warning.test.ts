import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { randomUUID } from 'node:crypto'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { computeTopoHash } from '../routes/resume-execution.js'

/**
 * AC-R3-1 黄警分句行为断言·常驻版（验收报告「建议后续 #3」，与
 * recover-budget-resume.test.ts 互补——那边 mock startWorkflowExecution 钉
 * 「预算三态取值链」，这边去 mock **真执行**钉「预算重新起算黄警帧」）：
 *
 * budget_exceeded run 续跑且沿用/携带预算时，resume 启动发一条 activity
 * 黄警披露谱系链累计已耗（NFR-6：没有它，用户会把前驱烧掉的 tokens 误读
 * 成本次续跑消耗）。断言走 R7 journal 真相源：delta 帧 write-behind 落
 * `run_node_journal`（kind='event'，settle 时 journal.close() flush）——
 * 黄警 label 全文与谱系 token 数、本次预算值逐字核对。
 */

const TEST_TIMEOUT_MS = 60_000

const FLOW_DATA = {
  nodes: [
    { id: 'node_1', type: 'customNode', position: { x: 0, y: 300 }, data: { name: 'startAgentflow', label: 'Start' } },
    {
      id: 'node_2',
      type: 'customNode',
      position: { x: 250, y: 300 },
      data: { name: 'directReplyAgentflow', label: 'Direct Reply', content: 'budget resume probe' },
    },
  ],
  edges: [{ id: 'edge_1_2', source: 'node_1', target: 'node_2' }],
}

let flowId = ''
let predecessorRunId = ''
let resumeRunId = ''

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  const runIds = [predecessorRunId, resumeRunId].filter(Boolean)
  if (runIds.length) {
    await runQuery(`DELETE FROM usage_events WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_node_journal WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_node_spans WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [runIds]).catch(() => {})
    await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [runIds]).catch(() => {})
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

describe('AC-R3-1 黄警：budget resume 披露谱系链累计已耗（真执行·journal 断言）', () => {
  it(
    'budget_exceeded 续跑（缺省沿用前驱预算 3000）→ journal event 帧含「预算重新起算（谱系链累计已耗 500 tokens）」',
    async () => {
      // ── 建图 ──
      const created = await app.request('/api/v1/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `budget-warning-${randomUUID().slice(0, 8)}`, flowData: FLOW_DATA }),
      })
      const flowIdFromRes = ((await created.json()) as { data?: { flow?: { id?: string } } }).data?.flow?.id
      expect(flowIdFromRes).toBeTruthy()
      flowId = flowIdFromRes!

      // ── 前驱：budget_exceeded + resumable checkpoint + 谱系账面 500 ──
      predecessorRunId = randomUUID()
      const topo = await computeTopoHash(FLOW_DATA)
      await runQuery(
        `INSERT INTO run_checkpoints (run_id, flow_id, status, topo_hash, snapshot)
         VALUES ($1::uuid, $2::uuid, 'resumable', $3, '{}'::jsonb)`,
        [predecessorRunId, flowId, topo],
      )
      await runQuery(
        `INSERT INTO runs (id, identifier, pipeline_id, status, input)
         VALUES ($1::uuid, $1, $2::uuid, 'budget_exceeded', $3::jsonb)`,
        [predecessorRunId, flowId, JSON.stringify({ input: 'x', tokenBudget: 3000 })],
      )
      await runQuery(
        `INSERT INTO usage_events (id, source, run_id, usage, priced)
         VALUES ($1::uuid, 'workflow_run', $2::uuid, $3::jsonb, false)`,
        [randomUUID(), predecessorRunId, JSON.stringify({ inputTokens: 300, outputTokens: 200 })],
      )

      // ── 续跑（缺省沿用 runs.input 的 tokenBudget=3000，无需 body 覆盖）──
      const res = await app.request(`/api/v1/workflows/runs/${predecessorRunId}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data?: { runId?: string; resumedFrom?: string } }
      expect(body.data?.runId).toBeTruthy()
      expect(body.data?.resumedFrom).toBe(predecessorRunId)
      resumeRunId = body.data!.runId!

      // 真执行收敛到终态（directReply 微图毫秒级；write-behind flush 在 settle）
      const finalRow = await pollUntil(
        () =>
          runQuery<{ status: string }>(`SELECT status FROM runs WHERE id = $1::uuid`, [resumeRunId]),
        (r) => ['completed', 'partial_success', 'failed'].includes(r.records[0]?.status ?? 'missing'),
      )
      expect(finalRow.records[0]?.status, `续跑应成功（实际 ${finalRow.records[0]?.status}）`).toBe('completed')

      // ── 黄警帧（journal 真相源，delta write-behind flush 后可见）──
      const warnRow = await pollUntil(
        () =>
          runQuery<{ payload: unknown }>(
            `SELECT payload FROM run_node_journal
              WHERE run_id = $1::uuid AND kind = 'event'
                AND payload::text LIKE '%预算重新起算%'`,
            [resumeRunId],
          ),
        (r) => r.records.length > 0,
      )
      const label = JSON.stringify(warnRow.records[0]?.payload)
      // label 全文契约（resume-execution.ts:389）：谱系已耗 + 本次预算双披露
      expect(label).toContain('谱系链累计已耗 500 tokens')
      expect(label).toContain('本次续跑预算 3000')
    },
    TEST_TIMEOUT_MS,
  )
})
