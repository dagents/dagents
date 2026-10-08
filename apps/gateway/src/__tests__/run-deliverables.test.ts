import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AppDataSource, runQuery } from '@dagents/db'
import { assertTestDatabase } from '../test-support/gw-test-db.js'
import { app } from '../app.js'
import {
  getRunDeliverables,
  projectDeliverableRows,
  buildRunDeliverables,
  deliverablesCounter,
} from '../repositories/run-deliverables.repo.js'

/**
 * R6 渐进产物读路径（design-artifacts.md §⑥ gateway 行）：
 *  - 纯函数：projectDeliverableRows（journal 行 / spans 兜底行归一、迭代多
 *    ordinal 保留、lineage 透传）与 buildRunDeliverables（引擎 success 过滤）。
 *  - 真库（dagents_gw_test，globalSetup 自动迁移）：journal 主路（迭代 3 项
 *    产 3 条 done decision）、兜底切换（无 journal 行回退 spans）、子流程
 *    flow_id join 归属名（text cast）、cached decision 行 lineage 载荷 →
 *    inheritedFromRunId 透传（AC-R6-3 读取侧）。
 *  - 端点级：真实 directReply 流跑通（零外部依赖）→ 同步终态响应体与
 *    node-spans 信封都携带 deliverables（§③-3/§③-4 的接线验证）。
 */

const createdRunIds: string[] = []
const createdFlowIds: string[] = []

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  assertTestDatabase(AppDataSource)
})

afterAll(async () => {
  assertTestDatabase(AppDataSource)
  for (const id of createdRunIds) {
    await runQuery(`DELETE FROM run_node_journal WHERE run_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM run_node_spans WHERE run_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM run_checkpoints WHERE run_id = $1::uuid`, [id]).catch(() => {})
    await runQuery(`DELETE FROM runs WHERE id = $1::uuid`, [id]).catch(() => {})
  }
  for (const id of createdFlowIds) {
    await runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [id]).catch(() => {})
  }
})

/** 测试桩：一根 flow + 一行 runs（status 可调）+ 登记清理。 */
async function mkRunFixture(opts: {
  name: string
  runStatus?: string
}): Promise<{ flowId: string; runId: string }> {
  const flowId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  createdFlowIds.push(flowId)
  createdRunIds.push(runId)
  await runQuery(
    `INSERT INTO flows (id, name, flow_data) VALUES ($1::uuid, $2, '{"nodes":[],"edges":[]}'::jsonb)`,
    [flowId, opts.name],
  )
  await runQuery(
    `INSERT INTO runs (id, identifier, pipeline_id, status, input, started_at)
     VALUES ($1::uuid, $1::text, $2, $3, '{}'::jsonb, NOW())`,
    [runId, flowId, opts.runStatus ?? 'failed'],
  )
  return { flowId, runId }
}

/** journal decision 行直插（payload 全量由调用方给）。 */
async function insertDecision(input: {
  runId: string
  flowId: string
  nodeId: string
  ordinal: number
  seq: number
  payload: Record<string, unknown>
}): Promise<void> {
  await runQuery(
    `INSERT INTO run_node_journal (run_id, flow_id, node_id, ordinal, kind, seq, payload)
     VALUES ($1::uuid, $2, $3, $4, 'decision', $5, $6::jsonb)`,
    [
      input.runId,
      input.flowId,
      input.nodeId,
      input.ordinal,
      input.seq,
      JSON.stringify(input.payload),
    ],
  )
}

/** span 行直插（兜底路 + journal 主路 label 元数据借阅共用）。 */
async function insertSpan(input: {
  runId: string
  flowId: string
  nodeId: string
  status: string
  ordinal?: number
  output?: Record<string, unknown>
  tokens?: Record<string, unknown>
}): Promise<void> {
  await runQuery(
    `INSERT INTO run_node_spans (run_id, flow_id, node_id, node_label, node_type, status, started_at, finished_at, duration_ms, tokens, input, output, ordinal)
     VALUES ($1::uuid, $2, $3, $3, 'llmAgentflow', $4, NOW(), NOW(), 10, $5::jsonb, '{}'::jsonb, $6::jsonb, $7)`,
    [
      input.runId,
      input.flowId,
      input.nodeId,
      input.status,
      input.tokens ? JSON.stringify(input.tokens) : null,
      input.output ? JSON.stringify(input.output) : null,
      input.ordinal ?? 0,
    ],
  )
}

describe('projectDeliverableRows（纯函数）', () => {
  it('journal decision 行：status/output/tokens/lineage 从 payload 透传', () => {
    const rows = [
      {
        node_id: 'a',
        ordinal: 0,
        payload: {
          status: 'done',
          output: { text: '产物 A' },
          tokens: { inputTokens: 3, outputTokens: 5 },
        },
        is_subflow: false,
        subflow_name: null,
      },
    ]
    const items = projectDeliverableRows(rows)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      nodeId: 'a',
      status: 'done',
      output: { text: '产物 A' },
      tokens: { inputTokens: 3, outputTokens: 5 },
      inheritedFromRunId: null,
      subflowName: null,
    })
  })

  it('cached decision 行：lineage.inheritedFromRunId 透传（AC-R6-3 读取侧）', () => {
    const items = projectDeliverableRows([
      {
        node_id: 'seed',
        ordinal: 0,
        payload: {
          status: 'cached',
          output: { text: '继承产物' },
          lineage: {
            inheritedFromRunId: '11111111-1111-4111-8111-111111111111',
            inheritedTokens: 7,
          },
        },
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.status).toBe('cached')
    expect(items[0]!.inheritedFromRunId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('spans 兜底行：status/output/tokens 直读，inheritedFromRunId 恒 null（无 lineage 载荷）', () => {
    const items = projectDeliverableRows([
      {
        node_id: 'b',
        node_label: '节点B',
        ordinal: 0,
        status: 'done',
        output: { content: 'B' },
        tokens: null,
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      nodeId: 'b',
      nodeLabel: '节点B',
      status: 'done',
      inheritedFromRunId: null,
    })
  })

  it('迭代多 ordinal 保留独立条目；词表外状态行剔除；空输入得空清单', () => {
    const items = projectDeliverableRows([
      { node_id: 'it', ordinal: 0, status: 'done', output: { text: '第0项' } },
      { node_id: 'it', ordinal: 1, status: 'failed', output: {} },
      { node_id: 'it', ordinal: 2, status: 'done', output: { text: '第2项' } },
      { node_id: 'x', ordinal: 0, status: 'running', output: {} },
    ])
    expect(items.map((i) => `${i.nodeId}#${i.ordinal}:${i.status}`)).toEqual([
      'it#0:done',
      'it#2:done',
    ])
    expect(projectDeliverableRows([])).toEqual([])
  })

  it('子流程归属：is_subflow 且有 name 才挂 subflowName（缺名/根图不挂）', () => {
    const items = projectDeliverableRows([
      { node_id: 's1', ordinal: 0, status: 'done', is_subflow: true, subflow_name: '子流程甲' },
      { node_id: 's2', ordinal: 0, status: 'done', is_subflow: true, subflow_name: null },
      { node_id: 'root', ordinal: 0, status: 'done', is_subflow: false, subflow_name: '不应出现' },
    ])
    expect(items.map((i) => i.subflowName)).toEqual(['子流程甲', null, null])
  })
})

describe('buildRunDeliverables（终态响应体纯函数）', () => {
  const executed = [
    {
      nodeId: 'a',
      nodeName: 'llmAgentflow',
      status: 'success',
      ordinal: 0,
      output: { text: 'A' },
      tokens: { inputTokens: 1, outputTokens: 2 },
    },
    { nodeId: 'b', nodeName: 'llmAgentflow', status: 'failed', ordinal: 0, output: {}, error: 'x' },
    { nodeId: 'c', nodeName: 'llmAgentflow', status: 'cancelled', ordinal: 0, output: {} },
    {
      nodeId: 'd',
      nodeName: 'llmAgentflow',
      status: 'success',
      ordinal: 1,
      output: { content: 'D1' },
    },
  ]

  it('只留引擎 success 节点；output/tokens 原样投影', () => {
    const items = buildRunDeliverables(executed)
    expect(items.map((i) => i.nodeId)).toEqual(['a', 'd'])
    expect(items[0]).toMatchObject({
      status: 'done',
      output: { text: 'A' },
      tokens: { inputTokens: 1, outputTokens: 2 },
      ordinal: 0,
    })
    expect(items[1]!.ordinal).toBe(1)
  })

  it('inheritedFromRunId/subflowName 恒 null；label/type 经查找表（缺表退 nodeName）', () => {
    const labels = new Map([['a', '翻译']])
    const types = new Map([['a', 'llmAgentflow']])
    const [a] = buildRunDeliverables(executed, labels, types)
    expect(a).toMatchObject({
      nodeLabel: '翻译',
      nodeType: 'llmAgentflow',
      inheritedFromRunId: null,
      subflowName: null,
    })
    const [bare] = buildRunDeliverables([executed[0]!])
    expect(bare!.nodeLabel).toBeNull()
    expect(bare!.nodeType).toBe('llmAgentflow')
  })
})

describe('getRunDeliverables（真库 dagents_gw_test）', () => {
  it('journal 主路：迭代 3 项 done decision 各一条（per-ordinal 不覆盖）+ failed 不入清单', async () => {
    const { flowId, runId } = await mkRunFixture({ name: 'r6-journal-main' })
    for (let i = 0; i < 3; i++) {
      await insertDecision({
        runId,
        flowId,
        nodeId: 'iterBody',
        ordinal: i,
        seq: i,
        payload: {
          status: 'done',
          output: { text: `第${i}项产物` },
          tokens: { inputTokens: i, outputTokens: i },
        },
      })
    }
    await insertDecision({
      runId,
      flowId,
      nodeId: 'badNode',
      ordinal: 0,
      seq: 99,
      payload: { status: 'failed', output: {}, error: 'boom' },
    })

    const { items, source } = await getRunDeliverables(runId)
    expect(source).toBe('journal')
    expect(items.map((i) => `${i.nodeId}#${i.ordinal}`)).toEqual([
      'iterBody#0',
      'iterBody#1',
      'iterBody#2',
    ])
    expect(
      items.every(
        (i) =>
          i.output &&
          typeof i.output === 'object' &&
          (i.output as { text?: string }).text === `第${i.ordinal}项产物`,
      ),
    ).toBe(true)
  })

  it('journal 权威空清单：只有 failed decision 时不回退 spans 造数', async () => {
    const { flowId, runId } = await mkRunFixture({ name: 'r6-journal-empty' })
    await insertDecision({
      runId,
      flowId,
      nodeId: 'onlyFail',
      ordinal: 0,
      seq: 0,
      payload: { status: 'failed' },
    })
    await insertSpan({
      runId,
      flowId,
      nodeId: 'spanDone',
      status: 'done',
      output: { text: '不应出现' },
    })

    const { items, source } = await getRunDeliverables(runId)
    expect(source).toBe('journal')
    expect(items).toEqual([])
  })

  it('兜底切换：无 journal 行的 runId 回退 spans 投影，inheritedFromRunId 恒 null', async () => {
    const { flowId, runId } = await mkRunFixture({ name: 'r6-spans-fallback' })
    await insertSpan({
      runId,
      flowId,
      nodeId: 'ok1',
      status: 'done',
      output: { text: '兜底产物' },
      tokens: { inputTokens: 2, outputTokens: 3 },
    })
    await insertSpan({
      runId,
      flowId,
      nodeId: 'ok2',
      status: 'cached',
      output: { text: '缓存种子' },
    })
    await insertSpan({ runId, flowId, nodeId: 'bad', status: 'failed', output: {} })

    const { items, source } = await getRunDeliverables(runId)
    expect(source).toBe('spans')
    expect(items.map((i) => i.nodeId)).toEqual(['ok1', 'ok2'])
    expect(items[0]).toMatchObject({
      output: { text: '兜底产物' },
      tokens: { inputTokens: 2, outputTokens: 3 },
    })
    expect(items.every((i) => i.inheritedFromRunId === null)).toBe(true)
  })

  it('子流程归属名：journal.flow_id ≠ runs.pipeline_id 时 join flows.name（text cast）', async () => {
    const { runId } = await mkRunFixture({ name: 'r6-subflow-parent' })
    const subFlowId = crypto.randomUUID()
    createdFlowIds.push(subFlowId)
    await runQuery(
      `INSERT INTO flows (id, name, flow_data) VALUES ($1::uuid, $2, '{"nodes":[],"edges":[]}'::jsonb)`,
      [subFlowId, 'r6-子流程甲'],
    )
    await insertDecision({
      runId,
      flowId: subFlowId,
      nodeId: 'subNode',
      ordinal: 0,
      seq: 0,
      payload: { status: 'done', output: { text: '子流程产物' } },
    })

    const { items } = await getRunDeliverables(runId)
    expect(items).toHaveLength(1)
    expect(items[0]!.subflowName).toBe('r6-子流程甲')
  })

  it('cached decision 行（lineage 载荷）：恰一条 + inheritedFromRunId 透传（AC-R6-3）', async () => {
    const { flowId, runId } = await mkRunFixture({ name: 'r6-cached-lineage' })
    const ancestor = crypto.randomUUID()
    await insertDecision({
      runId,
      flowId,
      nodeId: 'seedNode',
      ordinal: 0,
      seq: 0,
      payload: {
        status: 'cached',
        output: { text: '种子产物' },
        lineage: { inheritedFromRunId: ancestor },
      },
    })
    await insertDecision({
      runId,
      flowId,
      nodeId: 'freshNode',
      ordinal: 0,
      seq: 1,
      payload: { status: 'done', output: { text: '新执行产物' } },
    })

    const { items, source } = await getRunDeliverables(runId)
    expect(source).toBe('journal')
    expect(items).toHaveLength(2)
    const seed = items.find((i) => i.nodeId === 'seedNode')!
    expect(seed.inheritedFromRunId).toBe(ancestor)
    expect(items.filter((i) => i.nodeId === 'seedNode')).toHaveLength(1)
    expect(items.find((i) => i.nodeId === 'freshNode')!.inheritedFromRunId).toBeNull()
  })

  it('metrics 计数器随读路径打点（journal/spans source label 留痕）', async () => {
    // 前面的用例已打过点——这里只断言句柄可 inc 且不抛（注册表渲染在
    // metrics.test.ts 已有覆盖；source label 维度由本用例的读路径真实产生）。
    expect(() => deliverablesCounter.inc(0, { source: 'response' })).not.toThrow()
  })
})

describe('交付面接线（真实 HTTP 栈，directReply 流零外部依赖）', () => {
  it('同步终态响应体与 node-spans 信封都携带 deliverables（§③-3/③-4）', async () => {
    // 2 节点 directReply 链：start → d1（label 元数据来自 nodeLabelById）
    const createRes = await app.request('/api/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'r6-endpoint-wiring',
        flowData: {
          nodes: [
            {
              id: 's1',
              type: 'customNode',
              position: { x: 0, y: 0 },
              data: { name: 'startAgentflow' },
            },
            {
              id: 'd1',
              type: 'customNode',
              position: { x: 300, y: 0 },
              data: { name: 'directReplyAgentflow', label: '直答甲', text: 'R6-DELIV-OK' },
            },
          ],
          edges: [{ id: 'e1', source: 's1', target: 'd1' }],
        },
      }),
    })
    const flowId = ((await createRes.json()) as { data: { flow: { id: string } } }).data.flow.id
    createdFlowIds.push(flowId)

    // 同步路径（不走 async）：终态响应体直接带 deliverables
    const runRes = await app.request(`/api/v1/workflows/${flowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    expect(runRes.status).toBe(200)
    const runBody = (await runRes.json()) as {
      data?: {
        deliverables?: Array<{ nodeId: string; nodeLabel: string | null; status: string }>
      }
    }
    const runId = runRes.headers.get('x-run-id') as string
    createdRunIds.push(runId)
    // d1（directReply）是 success 交付项；start 节点引擎不产 success 终态
    const fromBody = runBody.data?.deliverables ?? []
    expect(fromBody.map((d) => d.nodeId)).toContain('d1')
    expect(fromBody.find((d) => d.nodeId === 'd1')).toMatchObject({
      nodeLabel: '直答甲',
      status: 'done',
      inheritedFromRunId: null,
      subflowName: null,
    })

    // 读面：node-spans 信封同一 runId 也携带（spans 兜底路——journal 写侧
    // 未接线时自动降级，行为可用）。span-writer 增量链是异步 fire-and-forget，
    // 同步响应后毫秒级最终一致 —— 轮询断言（真实消费方即 700ms 轮询）。
    await expect
      .poll(
        async () => {
          const spansRes = await app.request(`/api/v1/workflows/runs/${runId}/node-spans`)
          const spansBody = (await spansRes.json()) as {
            data?: {
              deliverables?: Array<{
                nodeId: string
                output: Record<string, unknown> | string | null
              }>
            }
          }
          return (spansBody.data?.deliverables ?? []).find((d) => d.nodeId === 'd1') ?? null
        },
        { timeout: 5000, interval: 100 },
      )
      .not.toBeNull()
    const spansRes = await app.request(`/api/v1/workflows/runs/${runId}/node-spans`)
    const spansBody = (await spansRes.json()) as {
      data?: {
        deliverables?: Array<{ nodeId: string; output: Record<string, unknown> | string | null }>
      }
    }
    const d1 = (spansBody.data?.deliverables ?? []).find((d) => d.nodeId === 'd1')
    // directReply 的产出形状是 { content }（direct-reply.node.ts:69）
    expect(d1?.output && typeof d1.output === 'object' && 'content' in d1.output).toBe(true)
  })

  it('中途失败 run：清单交付失败前完成节点、失败/未跑节点不入清单、runs.output 仍 NULL（AC-R6-1 核心断言的 gateway 层钉子）', async () => {
    // start → ok(directReply) → boom(customFunction 抛错，确定性失败) → after
    const createRes = await app.request('/api/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'r6-fail-rescue',
        flowData: {
          nodes: [
            {
              id: 's1',
              type: 'customNode',
              position: { x: 0, y: 0 },
              data: { name: 'startAgentflow' },
            },
            {
              id: 'ok',
              type: 'customNode',
              position: { x: 200, y: 0 },
              data: { name: 'directReplyAgentflow', label: '抢救产出', text: 'R6-RESCUE-OUT' },
            },
            {
              id: 'boom',
              type: 'customNode',
              position: { x: 400, y: 0 },
              data: {
                name: 'customFunctionAgentflow',
                label: 'boom',
                functionCode: 'throw new Error("R6-BOOM")',
              },
            },
            {
              id: 'after',
              type: 'customNode',
              position: { x: 600, y: 0 },
              data: { name: 'directReplyAgentflow', label: 'after', text: 'NEVER' },
            },
          ],
          edges: [
            { id: 'e1', source: 's1', target: 'ok' },
            { id: 'e2', source: 'ok', target: 'boom' },
            { id: 'e3', source: 'boom', target: 'after' },
          ],
        },
      }),
    })
    const flowId = ((await createRes.json()) as { data: { flow: { id: string } } }).data.flow.id
    createdFlowIds.push(flowId)

    // 同步路径：失败 run 走 500 分支，detail 里带 deliverables（§③-4 fail 分支）
    const runRes = await app.request(`/api/v1/workflows/${flowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    })
    expect(runRes.status).toBe(500)
    // fail() 的 extra 展开在响应顶层（lib/http.ts:30 fail 信封形状）
    const runBody = (await runRes.json()) as {
      error?: string
      deliverables?: Array<{ nodeId: string; nodeLabel: string | null }>
      executedNodes?: Array<{ nodeId: string; status: string }>
    }
    const runId = runRes.headers.get('x-run-id') as string
    createdRunIds.push(runId)
    // 引擎视角：success 节点入清单（start 也真实执行、终态 success），
    // boom(failed) / after(未跑) 剔除
    const fromBody = runBody.deliverables ?? []
    expect(fromBody.map((d) => d.nodeId)).toEqual(['s1', 'ok'])
    expect(fromBody.find((d) => d.nodeId === 'ok')).toMatchObject({ nodeLabel: '抢救产出' })

    // 读面（spans 兜底路）：ok + start 都有 done span → 都在清单；boom 不在
    const spansRes = await app.request(`/api/v1/workflows/runs/${runId}/node-spans`)
    const spansBody = (await spansRes.json()) as {
      data?: { runStatus?: string; deliverables?: Array<{ nodeId: string }> }
    }
    expect(spansBody.data?.runStatus).toBe('failed')
    expect((spansBody.data?.deliverables ?? []).map((d) => d.nodeId).sort()).toEqual(['ok', 's1'])

    // runs.output 语义不变：失败 run 无产出（清单是第二交付物，不回写 runs 行）。
    // 注意落库形态：outputJson = JSON.stringify(null) 即字符串 'null' →
    // jsonb 列得到的是 json null 标量，不是 SQL NULL——断言两者皆可。
    const sql = await runQuery<{ no_output: boolean }>(
      `SELECT (output IS NULL OR output = 'null'::jsonb) AS no_output FROM runs WHERE id = $1::uuid`,
      [runId],
    )
    expect(sql.records[0]?.no_output).toBe(true)
  })
})
