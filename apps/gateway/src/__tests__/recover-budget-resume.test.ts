/**
 * budget_exceeded resume 双路径 + 谱系继承 token 端点（design-recover
 * §3.3(d)，AC-R3-1 的「双路径：覆盖生效 / 缺省沿用前驱从零起算」行为断言；
 * R2.3 双口径的 node-spans 信封 lineageTokens）：
 *  - POST /runs/:runId/resume 的 tokenBudget 取值三态：body 覆盖 > runs.input
 *    沿用 > 无预算 undefined（引擎 tokenBudget 缺省 = 不设闸，从零起算的
 *    前提由引擎 tokensSpent 启动置 0 保证）；
 *  - GET /runs/:runId/node-spans 对有谱系锚的 run 附带 lineageTokens（链上
 *    前驱 usage_events SUM——双口径展示的继承侧）；根运行为 null。
 *
 * startWorkflowExecution 经部分 mock 捕获 req（真执行需要引擎/CLI 栈，
 * 路由取值链才是本套的钉子面）；buildResumeSeed/拓扑护栏保持真实现。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { app } from '../app.js'

const captured = vi.hoisted(() => ({ reqs: [] as Array<Record<string, unknown>> }))

vi.mock('../routes/resume-execution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/resume-execution.js')>()
  return {
    ...actual,
    startWorkflowExecution: (req: Record<string, unknown>) => {
      captured.reqs.push(req)
      return { runId: req.runId as string, done: Promise.resolve() }
    },
  }
})

const FLOW_ID = '00000000-0000-4000-8000-00000000aa01'
const RUN_OVERRIDE = '00000000-0000-4000-8000-00000000aa11'
const RUN_INHERIT = '00000000-0000-4000-8000-00000000aa12'
const RUN_NOBUDGET = '00000000-0000-4000-8000-00000000aa13'
const RUN_WARM = '00000000-0000-4000-8000-00000000aa21'
const RUN_ROOT = '00000000-0000-4000-8000-00000000aa22'
const ALL_RUNS = [RUN_OVERRIDE, RUN_INHERIT, RUN_NOBUDGET, RUN_WARM, RUN_ROOT]

const FLOW_DATA = {
  nodes: [{ id: 'a', type: 'customNode', data: { name: 'nodeA' } }],
  edges: [],
}

/** checkpoint 的 topo_hash 须与 loadFlow 后的 computeTopoHash 一致——直接算。 */
async function topoHashOf(flowData: unknown): Promise<string> {
  const { computeTopoHash } = await import('../routes/resume-execution.js')
  return computeTopoHash(flowData)
}

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
  await runQuery(
    `INSERT INTO flows (id, name, flow_data) VALUES ($1::uuid, 'budget-flow', $2::jsonb)`,
    [FLOW_ID, JSON.stringify(FLOW_DATA)],
  )
  const topo = await topoHashOf(FLOW_DATA)
  for (const runId of [RUN_OVERRIDE, RUN_INHERIT, RUN_NOBUDGET]) {
    await runQuery(
      `INSERT INTO run_checkpoints (run_id, flow_id, status, topo_hash, snapshot)
       VALUES ($1::uuid, $2::uuid, 'resumable', $3, '{}'::jsonb)`,
      [runId, FLOW_ID, topo],
    )
  }
  // 覆盖场景的 runs 行（input 无预算——覆盖值不依赖前驱）
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input)
     VALUES ($1::uuid, $1, $2::uuid, 'budget_exceeded', '{"input":"x"}')`,
    [RUN_OVERRIDE, FLOW_ID],
  )
  // 沿用场景：runs.input 带 tokenBudget（直跑带预算时的载荷形状）
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input)
     VALUES ($1::uuid, $1, $2::uuid, 'budget_exceeded', '{"input":"x","tokenBudget":3000}')`,
    [RUN_INHERIT, FLOW_ID],
  )
  // 老 run：input 无预算（迁移前形状）
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input)
     VALUES ($1::uuid, $1, $2::uuid, 'budget_exceeded', '{"input":"x"}')`,
    [RUN_NOBUDGET, FLOW_ID],
  )
  // ── lineageTokens 场景：warm run（谱系→root）+ root 的 usage_events ──
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, resumed_from_run_id)
     VALUES ($1::uuid, $1, $2::uuid, 'completed', '{}', $3::uuid)`,
    [RUN_WARM, FLOW_ID, RUN_ROOT],
  )
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input)
     VALUES ($1::uuid, $1, $2::uuid, 'completed', '{}')`,
    [RUN_ROOT, FLOW_ID],
  )
  await runQuery(
    `INSERT INTO usage_events (id, source, run_id, usage, cost, priced)
     VALUES (gen_random_uuid(), 'workflow_run', $1::uuid,
             '{"inputTokens":300,"outputTokens":200}'::jsonb, NULL, false)`,
    [RUN_ROOT],
  )
})

afterAll(async () => {
  await runQuery(`DELETE FROM usage_events WHERE run_id = ANY($1::uuid[])`, [ALL_RUNS]).catch(
    () => {},
  )
  await runQuery(`DELETE FROM run_checkpoints WHERE run_id = ANY($1::uuid[])`, [ALL_RUNS]).catch(
    () => {},
  )
  await runQuery(`DELETE FROM runs WHERE id = ANY($1::uuid[])`, [ALL_RUNS]).catch(() => {})
  await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [FLOW_ID]).catch(() => {})
})

const resume = (runId: string, body: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/v1/workflows/runs/${runId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  )

describe('budget_exceeded resume 双路径（AC-R3-1，§3.3(d)）', () => {
  it('路径① 覆盖生效：body tokenBudget=5000 → 执行请求带 5000（不吃前驱值）', async () => {
    captured.reqs = []
    const res = await resume(RUN_OVERRIDE, { tokenBudget: 5000 })
    expect(res.status).toBe(200)
    expect(captured.reqs).toHaveLength(1)
    expect(captured.reqs[0]!.tokenBudget).toBe(5000)
  })

  it('路径② 缺省沿用前驱：body 空 + runs.input tokenBudget=3000 → 执行请求带 3000', async () => {
    captured.reqs = []
    const res = await resume(RUN_INHERIT, {})
    expect(res.status).toBe(200)
    expect(captured.reqs).toHaveLength(1)
    expect(captured.reqs[0]!.tokenBudget).toBe(3000)
  })

  it('路径③ 老 run 无预算：执行请求不带 tokenBudget（undefined——引擎不设闸）', async () => {
    captured.reqs = []
    const res = await resume(RUN_NOBUDGET, {})
    expect(res.status).toBe(200)
    expect(captured.reqs).toHaveLength(1)
    expect(captured.reqs[0]!.tokenBudget).toBeUndefined()
  })

  it('非法预算值被 schema 拒（400——覆盖面只收正整数）', async () => {
    captured.reqs = []
    const res = await resume(RUN_OVERRIDE, { tokenBudget: -5 })
    expect(res.status).toBe(400)
    expect(captured.reqs).toHaveLength(0)
  })
})

describe('node-spans 信封 lineageTokens（R2.3 双口径继承侧）', () => {
  it('有谱系锚的 run：附带链上前驱 usage_events SUM（本 run 自身不计入）', async () => {
    const res = await app.request(`/api/v1/workflows/runs/${RUN_WARM}/node-spans`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data?: { lineageTokens?: number | null } }
    expect(json.data?.lineageTokens).toBe(500)
  })

  it('根运行：lineageTokens null（无双口径行）', async () => {
    const res = await app.request(`/api/v1/workflows/runs/${RUN_ROOT}/node-spans`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data?: { lineageTokens?: number | null } }
    expect(json.data?.lineageTokens).toBeNull()
  })
})
