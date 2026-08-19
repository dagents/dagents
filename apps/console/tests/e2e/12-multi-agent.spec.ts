import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import {
  createSeedContext,
  seedMockLlmProvider,
  seedFlow,
  seedPlatformAgent,
  resetMockLlm,
  setMockLlmScript,
  mockLlmCalls,
  type SeedContext,
} from './helpers/seed'
import {
  flow,
  edge,
  startNode,
  llmNode,
  platformAgentNode,
  directReplyNode,
  customFunctionNode,
  conditionNode,
  conditionAgentNode,
  toolNode,
  humanInputNode,
  executeFlowNode,
  iterationNode,
  loopNode,
  linearFlow,
  parallelFlow,
} from './helpers/flow-builder'

/**
 * 12 — 多 Agent 协作专项（docs/e2e-test-plan.md §5.1 MA-01~18，Phase 1 T1-2~T1-7）。
 *
 * 核心断言三件套：
 *  1. node-spans 的 node_id 集合 = 实际执行集（并行/剪枝/失败的真相）；
 *  2. mock 调用记录（/__control/calls）= 协作证据（谁收到什么 prompt、工具
 *     是否回灌、循环了几轮）；
 *  3. DB runs 行 = 终态（completed/failed）。
 *
 * PlatformAgent 是多 Agent 协作主角：agentId 从 seedPlatformAgent 来，节点级
 * systemPrompt 区分角色（同一 Agent 行可复用，MA-11 专测指令隔离）。
 */

interface MockMessage {
  role: string
  content: unknown
}
interface MockCall {
  seq: number
  model: string
  messages: MockMessage[]
  tools: Array<{ function: { name: string } }> | null
  matchedRule: string
  response: { mode: string; text?: string; toolCalls?: unknown[] }
}

/** 取 system prompt 含 marker 的 mock 调用（每个角色/节点的协作证据定位器）。 */
function callsOfRole(calls: MockCall[], marker: string): MockCall[] {
  return calls.filter((c) =>
    (c.messages ?? []).some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(marker)),
  )
}

async function runFlow(request: APIRequestContext, flowId: string, body: Record<string, unknown> = { input: 'go' }) {
  const res = await request.post(`/api/workflows/${flowId}/run`, { data: body })
  const json = await res.json()
  return { status: res.status(), body: json, runId: res.headers()['x-run-id'] as string }
}

async function getSpans(request: APIRequestContext, runId: string) {
  const res = await request.get(`/api/workflows/runs/${runId}/node-spans`)
  const json = await res.json()
  return (json.data?.spans ?? []) as Array<{
    nodeId: string
    status: string
    startedAt: string | null
    finishedAt: string | null
    error: string | null
    input: unknown
    output: unknown
  }>
}

test.describe('多 Agent 协作专项（MA-01 ~ MA-18）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })
  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('MA-01: 并行多 Agent 同波次 —— spans 时间重叠 + 多入边合并', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, {
      name: 'ma01-worker',
      instructions: 'AGENT-BASE-MA01',
    })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:PLANNER' }, respond: { text: 'PLANNER-OUT-XYZ', delayMs: 120 } },
        { match: { systemContains: 'ROLE:CODER' }, respond: { text: 'CODER-OUT-XYZ', delayMs: 120 } },
        { match: { systemContains: 'ROLE:TESTER' }, respond: { text: 'TESTER-OUT-XYZ', delayMs: 120 } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma01-parallel',
      flowData: parallelFlow(
        [
          [platformAgentNode('planner', { agentId, systemPrompt: 'ROLE:PLANNER' })],
          [platformAgentNode('coder', { agentId, systemPrompt: 'ROLE:CODER' })],
          [platformAgentNode('tester', { agentId, systemPrompt: 'ROLE:TESTER' })],
        ],
        // sink 用 CustomFunction 回显 $input —— 多入边合并结果对节点可见，
        // 而其输出可在 finalOutput/spans 断言（DirectReply 的 span input 记录
        // 的是自身配置，观测不到合并）。
        customFunctionNode('merge', { code: `return { merged: $input }` }),
      ),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '并行开工' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)
    expect(body.success).toBe(true)

    const spans = await getSpans(request, runId)
    const workers = ['planner', 'coder', 'tester'].map((id) => spans.find((s) => s.nodeId === id))
    expect(workers.every(Boolean)).toBe(true)
    expect(workers.every((s) => s!.status === 'done')).toBe(true)

    // 真并发证明：三者执行窗口两两重叠（同时刻都在跑），而非串行接力
    const starts = workers.map((s) => Date.parse(s!.startedAt as string))
    const ends = workers.map((s) => Date.parse(s!.finishedAt as string))
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends))

    // 多入边合并：merge 节点的输出（= 它收到的 $input）含全部三份产出
    //（多入边 content 以换行拼接）
    const merged = JSON.stringify(body.data?.output)
    expect(merged).toContain('PLANNER-OUT-XYZ')
    expect(merged).toContain('CODER-OUT-XYZ')
    expect(merged).toContain('TESTER-OUT-XYZ')
  })

  test('MA-02: 顺序接龙 —— 执行序单调 + B 收到 A 的产出', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma02-chain', instructions: 'AGENT-BASE-MA02' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:ANALYST' }, respond: { text: 'ANALYST-OUT-42' } },
        { match: { systemContains: 'ROLE:DESIGNER' }, respond: { text: 'DESIGNER-OUT-77' } },
        { match: { systemContains: 'ROLE:REVIEWER' }, respond: { text: 'REVIEW-VERDICT-99' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma02-handoff',
      flowData: linearFlow([
        platformAgentNode('a', { agentId, systemPrompt: 'ROLE:ANALYST' }),
        platformAgentNode('b', { agentId, systemPrompt: 'ROLE:DESIGNER' }),
        platformAgentNode('c', { agentId, systemPrompt: 'ROLE:REVIEWER' }),
      ]),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '接龙需求' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    // 执行序 a → b → c（startedAt 单调不减）
    const spans = await getSpans(request, runId)
    const at = (id: string) => Date.parse(spans.find((s) => s.nodeId === id)!.startedAt as string)
    expect(at('a')).toBeLessThanOrEqual(at('b'))
    expect(at('b')).toBeLessThanOrEqual(at('c'))

    // 接龙证据：B 的 user 消息含 A 的产出，C 的 user 消息含 B 的产出
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    const bCall = callsOfRole(calls, 'ROLE:DESIGNER')[0]
    const cCall = callsOfRole(calls, 'ROLE:REVIEWER')[0]
    expect(bCall.messages.some((m) => m.role === 'user' && String(m.content).includes('ANALYST-OUT-42'))).toBe(true)
    expect(cCall.messages.some((m) => m.role === 'user' && String(m.content).includes('DESIGNER-OUT-77'))).toBe(true)

    // 最终输出 = 链尾 c 的评审
    expect(body.data?.output).toMatchObject({ content: 'REVIEW-VERDICT-99' })
  })

  test('MA-03: Condition 确定性分支 —— 未选分支无 span，同流两跑互斥', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma03-router', instructions: 'AGENT-BASE-MA03' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:BRANCH-A' }, respond: { text: 'BRANCH-A-TOOK' } },
        { match: { systemContains: 'ROLE:BRANCH-B' }, respond: { text: 'BRANCH-B-TOOK' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma03-condition',
      flowData: flow(
        [
          startNode('start'),
          customFunctionNode('len', {
            code: `return { content: String($input).length > 10 ? 'long' : 'short' }`,
          }),
          conditionNode('cond', {
            conditions: [{ comparisonOperator: 'contains', valueToCompare: '{{input}}', valueToCompareAgainst: 'long' }],
          }),
          platformAgentNode('agentA', { agentId, systemPrompt: 'ROLE:BRANCH-A' }),
          platformAgentNode('agentB', { agentId, systemPrompt: 'ROLE:BRANCH-B' }),
        ],
        [
          edge('start', 'len'),
          edge('len', 'cond'),
          edge('cond', 'agentA', 'true'),
          edge('cond', 'agentB', 'false'),
        ],
      ),
    })

    // 第一跑：长输入 → true 分支，只有 agentA
    const run1 = await runFlow(request, flowId, { input: 'this-is-a-long-enough-input' })
    ctx.runIds.push(run1.runId)
    expect(run1.status).toBe(200)
    const spans1 = await getSpans(request, run1.runId)
    expect(spans1.find((s) => s.nodeId === 'agentA')?.status).toBe('done')
    expect(spans1.find((s) => s.nodeId === 'agentB')).toBeUndefined()

    // 第二跑（同一 flow）：短输入 → false 分支，只有 agentB —— 剪枝互斥
    const run2 = await runFlow(request, flowId, { input: 'short' })
    ctx.runIds.push(run2.runId)
    expect(run2.status).toBe(200)
    const spans2 = await getSpans(request, run2.runId)
    expect(spans2.find((s) => s.nodeId === 'agentB')?.status).toBe('done')
    expect(spans2.find((s) => s.nodeId === 'agentA')).toBeUndefined()
  })

  test('MA-04: ConditionAgent 场景路由 —— LLM 决策 selected 剪枝', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma04-worker', instructions: 'AGENT-BASE-MA04' })
    await setMockLlmScript({
      rules: [
        { match: { userContains: 'routing-signal-bug' }, respond: { text: 'bug' } },
        { match: { userContains: 'routing-signal-feature' }, respond: { text: 'feature' } },
        { match: { systemContains: 'ROLE:FIX-BUG' }, respond: { text: 'BUG-FIXED' } },
        { match: { systemContains: 'ROLE:BUILD-FEATURE' }, respond: { text: 'FEATURE-BUILT' } },
        { match: { systemContains: 'ROLE:WRITE-DOCS' }, respond: { text: 'DOCS-WRITTEN' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma04-scenario',
      flowData: flow(
        [
          startNode('start'),
          conditionAgentNode('router', {
            scenarios: [
              { name: 'bug', description: '缺陷修复' },
              { name: 'feature', description: '新功能' },
              { name: 'docs', description: '文档' },
            ],
          }),
          platformAgentNode('agentBug', { agentId, systemPrompt: 'ROLE:FIX-BUG' }),
          platformAgentNode('agentFeature', { agentId, systemPrompt: 'ROLE:BUILD-FEATURE' }),
          platformAgentNode('agentDocs', { agentId, systemPrompt: 'ROLE:WRITE-DOCS' }),
        ],
        [
          edge('start', 'router'),
          edge('router', 'agentBug', 'bug'),
          edge('router', 'agentFeature', 'feature'),
          edge('router', 'agentDocs', 'docs'),
        ],
      ),
    })

    const run1 = await runFlow(request, flowId, { input: 'routing-signal-bug 页面崩溃' })
    ctx.runIds.push(run1.runId)
    expect(run1.status).toBe(200)
    const spans1 = await getSpans(request, run1.runId)
    // selected=bug 正确路由 + 另两路剪枝
    expect(JSON.stringify(spans1.find((s) => s.nodeId === 'router')?.output)).toContain('"bug"')
    expect(spans1.find((s) => s.nodeId === 'agentBug')?.status).toBe('done')
    expect(spans1.find((s) => s.nodeId === 'agentFeature')).toBeUndefined()
    expect(spans1.find((s) => s.nodeId === 'agentDocs')).toBeUndefined()

    // 换信号重跑 → 只有 feature 分支
    const run2 = await runFlow(request, flowId, { input: 'routing-signal-feature 加一个导出按钮' })
    ctx.runIds.push(run2.runId)
    const spans2 = await getSpans(request, run2.runId)
    expect(spans2.find((s) => s.nodeId === 'agentFeature')?.status).toBe('done')
    expect(spans2.find((s) => s.nodeId === 'agentBug')).toBeUndefined()
  })

  test('MA-05: Agent + 工具协作循环 —— tool_call → 回灌 → 最终答案', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma05-weatherman', instructions: 'AGENT-BASE-MA05' })
    await setMockLlmScript({
      rules: [
        {
          label: 'round1-ask-tool',
          match: { systemContains: 'ROLE:WEATHER', hasToolResult: false },
          respond: {
            toolCalls: [{ id: 'call_w1', function: { name: 'weather_lookup', arguments: '{"city":"beijing"}' } }],
          },
        },
        {
          label: 'round2-final',
          match: { systemContains: 'ROLE:WEATHER', toolResultContains: '24' },
          respond: { text: 'WEATHER-FINAL: 晴 24度' },
        },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma05-toolloop',
      flowData: linearFlow([
        toolNode('tool', {
          toolName: 'weather_lookup',
          toolDescription: '查询城市天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          toolInput: { city: 'beijing' },
          handler: `return { temp: 24, cond: '晴' }`,
        }),
        platformAgentNode('agent', { agentId, systemPrompt: 'ROLE:WEATHER 查询天气并汇报' }),
      ]),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '北京今天天气' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    // Tool 节点先执行注册 + 在流内跑一次 handler
    const spans = await getSpans(request, runId)
    expect(spans.find((s) => s.nodeId === 'tool')?.status).toBe('done')

    // 协作闭环证据：该节点恰好 2 次 LLM 调用；第 2 次 messages 含 role:'tool'
    // 的真实回灌（handler 返回值），且最终文本引用工具数据
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    const rounds = callsOfRole(calls, 'ROLE:WEATHER')
    expect(rounds).toHaveLength(2)
    expect(rounds[0].tools?.some((t) => t.function.name === 'weather_lookup')).toBe(true)
    expect(
      rounds[1].messages.some((m) => m.role === 'tool' && String(m.content).includes('24')),
    ).toBe(true)
    expect(body.data?.output).toMatchObject({ content: 'WEATHER-FINAL: 晴 24度' })
  })

  test('MA-06: Iteration 逐项批量协作 —— 3 轮逐项处理 + 聚合', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma06-batcher', instructions: 'AGENT-BASE-MA06' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ITEM:alpha' }, respond: { text: 'ITER-OUT-alpha' } },
        { match: { systemContains: 'ITEM:beta' }, respond: { text: 'ITER-OUT-beta' } },
        { match: { systemContains: 'ITEM:gamma' }, respond: { text: 'ITER-OUT-gamma' } },
      ],
      fallback: { text: 'ITER-OUT-generic' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma06-iteration',
      flowData: flow(
        [
          startNode('start'),
          iterationNode('iter', { items: ['alpha', 'beta', 'gamma'] }),
          platformAgentNode('worker', { agentId, systemPrompt: '逐项处理，当前项 ITEM:{{iterationItem}}' }),
          directReplyNode('reply', { text: 'ITER-DONE' }),
        ],
        [
          edge('start', 'iter'),
          edge('iter', 'worker', 'iteration'),
          edge('iter', 'reply', 'result'),
        ],
      ),
    })

    const { status, runId } = await runFlow(request, flowId, { input: '批量处理' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    // 3 轮，每轮 system 含各自 iterationItem、user 消息就是该项
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    const itemCalls = ['alpha', 'beta', 'gamma'].map((item) => callsOfRole(calls, `ITEM:${item}`)[0])
    expect(itemCalls.every(Boolean)).toBe(true)
    for (const [i, item] of ['alpha', 'beta', 'gamma'].entries()) {
      expect(itemCalls[i]!.messages.some((m) => m.role === 'user' && m.content === item)).toBe(true)
    }

    // 控制器聚合：completedIterations=3，iterations 数组含每项结果
    const spans = await getSpans(request, runId)
    const iterSpan = spans.find((s) => s.nodeId === 'iter')
    const iterOut = JSON.stringify(iterSpan?.output)
    expect(iterOut).toContain('"completedIterations":3')
    expect(iterOut).toContain('ITER-OUT-alpha')
    expect(iterOut).toContain('ITER-OUT-beta')
    expect(iterOut).toContain('ITER-OUT-gamma')
  })

  test('MA-07: Loop 循环协作 + break —— state 跨轮传递提前跳出', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma07-improver', instructions: 'AGENT-BASE-MA07' })
    await setMockLlmScript({
      rules: [{ match: { systemContains: 'ROLE:IMPROVE' }, respond: { text: 'IMPROVE-R1' } }],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma07-loop',
      flowData: flow(
        [
          startNode('start'),
          loopNode('loop', { maxIterations: 5, condition: '$flow.state.checker.value === true' }),
          platformAgentNode('improve', { agentId, systemPrompt: 'ROLE:IMPROVE 改进当前稿' }),
          customFunctionNode('checker', { code: `return { value: true }` }),
          directReplyNode('reply', { text: 'LOOP-DONE' }),
        ],
        [
          edge('start', 'loop'),
          edge('loop', 'improve', 'loop'),
          edge('improve', 'checker'),
          edge('loop', 'reply', 'result'),
        ],
      ),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '改进这份稿子' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    // checker 第 1 轮置 done → 第 2 轮前 break：agent 只跑 1 轮（<5）
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    expect(callsOfRole(calls, 'ROLE:IMPROVE')).toHaveLength(1)

    const spans = await getSpans(request, runId)
    const loopOut = JSON.stringify(spans.find((s) => s.nodeId === 'loop')?.output)
    expect(loopOut).toContain('"completedIterations":1')
    // 循环体聚合取「body 内拓扑最深」节点（improve→checker 里的 checker），
    // improve 的产出在其自身 span 输出里
    expect(JSON.stringify(spans.find((s) => s.nodeId === 'improve')?.output)).toContain('IMPROVE-R1')
    expect(spans.find((s) => s.nodeId === 'checker')?.status).toBe('done')
    // result 路径继续执行
    expect(spans.find((s) => s.nodeId === 'reply')?.status).toBe('done')
    // 引擎语义（executor.ts 循环聚合覆盖 controller 记录）：finalOutput 是
    // 循环聚合输出（body 最深节点 checker 的 {value:true}），而非 result
    // 路径上更深的 reply —— 用 e2e 钉住这个真实行为。
    expect(body.data?.output).toMatchObject({ value: true })
  })

  test('MA-08: 子流程编排 —— span 合并/输出汇聚/深度上限/失败传播', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma08-crew', instructions: 'AGENT-BASE-MA08' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:COPYWRITER' }, respond: { text: 'SUB1-OUT' } },
        { match: { systemContains: 'ROLE:ARTIST' }, respond: { text: 'SUB2-OUT' } },
        { match: { systemContains: 'ROLE:SUBFAIL' }, respond: { mode: 'error' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })

    const sub1 = await seedFlow(ctx, request, {
      name: 'e2e-ma08-sub1',
      flowData: flow(
        [startNode('s1start'), platformAgentNode('s1agent', { agentId, systemPrompt: 'ROLE:COPYWRITER' })],
        [edge('s1start', 's1agent')],
      ),
    })
    const sub2 = await seedFlow(ctx, request, {
      name: 'e2e-ma08-sub2',
      flowData: flow(
        [startNode('s2start'), platformAgentNode('s2agent', { agentId, systemPrompt: 'ROLE:ARTIST' })],
        [edge('s2start', 's2agent')],
      ),
    })
    const parent = await seedFlow(ctx, request, {
      name: 'e2e-ma08-parent',
      flowData: parallelFlow(
        [[executeFlowNode('e1', { flowId: sub1 })], [executeFlowNode('e2', { flowId: sub2 })]],
        // 与 MA-01 同理：用 CustomFunction 回显合并输入，观测两个子流程输出的汇聚
        customFunctionNode('merge', { code: `return { merged: $input }` }),
      ),
    })

    // 1) 并行两个子流程：子流程节点合并进父 run 的 spans；输出汇聚进父流
    const { status, body, runId } = await runFlow(request, parent, { input: '制作内容包' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)
    const spans = await getSpans(request, runId)
    expect(spans.find((s) => s.nodeId === 's1agent')?.status).toBe('done')
    expect(spans.find((s) => s.nodeId === 's2agent')?.status).toBe('done')
    const merged = JSON.stringify(body.data?.output)
    expect(merged).toContain('SUB1-OUT')
    expect(merged).toContain('SUB2-OUT')

    // 2) 深度上限：L4 → L3 → L2 → L1 → L0 链，第 4 层 ExecuteFlow 明确报错
    const l0 = await seedFlow(ctx, request, {
      name: 'e2e-ma08-l0',
      flowData: flow([startNode('l0start')], []),
    })
    let prev = l0
    const chainIds: string[] = []
    for (let level = 1; level <= 4; level++) {
      const id = await seedFlow(ctx, request, {
        name: `e2e-ma08-l${level}`,
        flowData: flow(
          [startNode(`l${level}start`), executeFlowNode(`l${level}ef`, { flowId: prev })],
          [edge(`l${level}start`, `l${level}ef`)],
        ),
      })
      chainIds.push(id)
      prev = id
    }
    const deep = await runFlow(request, prev, { input: '深挖' })
    ctx.runIds.push(deep.runId)
    expect(deep.status).toBe(500)
    expect(String(deep.body.error)).toContain('exceeds max depth')

    // 3) 子流程失败 → 父 run failed，失败来源进 spans
    const subFail = await seedFlow(ctx, request, {
      name: 'e2e-ma08-subfail',
      flowData: flow(
        [startNode('sfStart'), platformAgentNode('sfAgent', { agentId, systemPrompt: 'ROLE:SUBFAIL' })],
        [edge('sfStart', 'sfAgent')],
      ),
    })
    const parentFail = await seedFlow(ctx, request, {
      name: 'e2e-ma08-parent-fail',
      flowData: flow(
        [startNode('pfStart'), executeFlowNode('pfEf', { flowId: subFail })],
        [edge('pfStart', 'pfEf')],
      ),
    })
    const failed = await runFlow(request, parentFail, { input: '会失败的编排' })
    ctx.runIds.push(failed.runId)
    expect(failed.status).toBe(500)
    expect(String(failed.body.error)).toContain('failed')
    const failSpans = await getSpans(request, failed.runId)
    expect(failSpans.find((s) => s.nodeId === 'sfAgent')?.status).toBe('failed')
    expect(failSpans.find((s) => s.nodeId === 'pfEf')?.status).toBe('failed')
    const { records: failRuns } = await ctx.db.runQuery<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [failed.runId],
    )
    expect(failRuns[0]?.status).toBe('failed')
  })

  test('MA-09: HumanInput API 路径 —— 预置答案成功 / 缺失明确报错', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma09-pipeline', instructions: 'AGENT-BASE-MA09' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:PRE' }, respond: { text: 'PRE-PROPOSAL' } },
        { match: { systemContains: 'ROLE:POST' }, respond: { text: 'POST-EXECUTED' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma09-human',
      flowData: linearFlow([
        platformAgentNode('pre', { agentId, systemPrompt: 'ROLE:PRE 出方案' }),
        humanInputNode('confirm', { prompt: '确认方案' }),
        platformAgentNode('post', { agentId, systemPrompt: 'ROLE:POST 执行确认后的方案' }),
      ]),
    })

    // 预置答案 → 全链完成，B 收到人类答案
    const ok = await runFlow(request, flowId, {
      input: '开始',
      state: { humanInputs: { 确认方案: '采用方案一' } },
    })
    ctx.runIds.push(ok.runId)
    expect(ok.status).toBe(200)
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    const postCall = callsOfRole(calls, 'ROLE:POST')[0]
    expect(postCall.messages.some((m) => m.role === 'user' && String(m.content).includes('采用方案一'))).toBe(true)
    expect(ok.body.data?.output).toMatchObject({ content: 'POST-EXECUTED' })

    // 缺答案 → 明确报错并指向 chat 路径，不挂死
    const missing = await runFlow(request, flowId, { input: '再来一次' })
    ctx.runIds.push(missing.runId)
    expect(missing.status).toBe(500)
    expect(String(missing.body.error)).toContain('HumanInput node has no pre-supplied answer')
    expect(String(missing.body.error)).toContain('chat')
    const spans = await getSpans(request, missing.runId)
    expect(spans.find((s) => s.nodeId === 'confirm')?.status).toBe('failed')
  })

  test('MA-10: 多 Agent 中一个失败 —— 同波次失败语义', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma10-duo', instructions: 'AGENT-BASE-MA10' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:GOOD' }, respond: { text: 'GOOD-OUT' } },
        { match: { systemContains: 'ROLE:BAD' }, respond: { mode: 'error' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma10-failwave',
      flowData: parallelFlow(
        [
          [platformAgentNode('good', { agentId, systemPrompt: 'ROLE:GOOD' })],
          [platformAgentNode('bad', { agentId, systemPrompt: 'ROLE:BAD' })],
        ],
        directReplyNode('reply', { text: 'SHOULD-NOT-RUN' }),
      ),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '并行但有人翻车' })
    ctx.runIds.push(runId)
    expect(status).toBe(500)
    expect(body.success).toBe(false)

    const spans = await getSpans(request, runId)
    // A 正常完成；B failed 且带 error；下游 reply 被剪枝
    expect(spans.find((s) => s.nodeId === 'good')?.status).toBe('done')
    const badSpan = spans.find((s) => s.nodeId === 'bad')
    expect(badSpan?.status).toBe('failed')
    expect(badSpan?.error ?? '').not.toBe('')
    expect(spans.find((s) => s.nodeId === 'reply')).toBeUndefined()

    const { records: runRows } = await ctx.db.runQuery<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    )
    expect(runRows[0]?.status).toBe('failed')
  })

  test('MA-11: PlatformAgent 任务指令隔离 —— 同一 Agent 多职责', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma11-hat', instructions: 'AGENT-BASE-MA11' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:PLANNER' }, respond: { text: 'PLAN-OUT' } },
        { match: { systemContains: 'ROLE:CODER' }, respond: { text: 'CODE-OUT' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma11-isolation',
      flowData: parallelFlow([
        [platformAgentNode('p', { agentId, systemPrompt: 'ROLE:PLANNER 只做规划' })],
        [platformAgentNode('c', { agentId, systemPrompt: 'ROLE:CODER 只写代码' })],
      ]),
    })

    const { status, runId } = await runFlow(request, flowId, { input: '分工' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    // 定位器用本用例独有的 Agent 基座标记（调用记录跨用例累积，角色名
    // ROLE:PLANNER 在 MA-01 也出现过，不能作唯一定位）
    const sysOf = (call: MockCall) => String(call.messages.find((m) => m.role === 'system')?.content ?? '')
    const pCall = callsOfRole(calls, 'AGENT-BASE-MA11').find((c) => sysOf(c).includes('ROLE:PLANNER'))
    const cCall = callsOfRole(calls, 'AGENT-BASE-MA11').find((c) => sysOf(c).includes('ROLE:CODER'))
    expect(pCall).toBeTruthy()
    expect(cCall).toBeTruthy()
    // 两个节点都收到 Agent 基座 instructions + 各自节点任务指令，且互不泄漏
    expect(sysOf(pCall!)).toContain('AGENT-BASE-MA11')
    expect(sysOf(pCall!)).toContain('ROLE:PLANNER')
    expect(sysOf(pCall!)).not.toContain('ROLE:CODER')
    expect(sysOf(cCall!)).toContain('AGENT-BASE-MA11')
    expect(sysOf(cCall!)).toContain('ROLE:CODER')
    expect(sysOf(cCall!)).not.toContain('ROLE:PLANNER')
  })

  test('MA-12: Tool 注册按 run 隔离 —— 上个 flow 的工具不泄漏', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma12-watcher', instructions: 'AGENT-BASE-MA12' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:TOOLUSER' }, respond: { text: 'TOOLUSER-OK' } },
        { match: { systemContains: 'ROLE:ISOLATED' }, respond: { text: 'ISO-OK' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })

    // flow1：注册 weather_lookup 并使用
    const flow1 = await seedFlow(ctx, request, {
      name: 'e2e-ma12-f1',
      flowData: linearFlow([
        toolNode('tool', {
          toolName: 'weather_lookup',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          handler: `return { temp: 24, cond: '晴' }`,
        }),
        platformAgentNode('agent', { agentId, systemPrompt: 'ROLE:TOOLUSER' }),
      ]),
    })
    const run1 = await runFlow(request, flow1, { input: '带工具跑' })
    ctx.runIds.push(run1.runId)
    expect(run1.status).toBe(200)

    // flow2（独立 run，无 Tool 节点）：agent 看不到 weather_lookup
    const flow2 = await seedFlow(ctx, request, {
      name: 'e2e-ma12-f2',
      flowData: flow(
        [startNode('start'), platformAgentNode('agent', { agentId, systemPrompt: 'ROLE:ISOLATED' })],
        [edge('start', 'agent')],
      ),
    })
    const run2 = await runFlow(request, flow2, { input: '裸跑' })
    ctx.runIds.push(run2.runId)
    expect(run2.status).toBe(200)

    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    const isoCall = callsOfRole(calls, 'ROLE:ISOLATED').at(-1)!
    const toolNames = (isoCall.tools ?? []).map((t) => t.function.name)
    expect(toolNames).not.toContain('weather_lookup')
    // 内建工具仍在（registry 是 run 级覆盖层，不是全局清空）
    expect(toolNames).toContain('http_request')
  })

  test('MA-13: 多 Agent 输出合并进最终回复 —— 模板变量拼接', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma13-pair', instructions: 'AGENT-BASE-MA13' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:MA13-A' }, respond: { text: 'A-OUT-1' } },
        { match: { systemContains: 'ROLE:MA13-B' }, respond: { text: 'B-OUT-2' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma13-merge',
      flowData: parallelFlow(
        [
          [platformAgentNode('a', { agentId, systemPrompt: 'ROLE:MA13-A' })],
          [platformAgentNode('b', { agentId, systemPrompt: 'ROLE:MA13-B' })],
        ],
        directReplyNode('reply', { text: '合并:{{a.content}} || {{b.content}}' }),
      ),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '合并汇报' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)
    // 模板变量 {{nodeId.content}} 从 state 解析，两份产出都进最终回复
    expect(body.data?.output).toMatchObject({ content: '合并:A-OUT-1 || B-OUT-2' })
  })

  test('MA-14: 失败分支的下游剪枝 —— 失败节点与未执行后继的组合', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma14-conditional', instructions: 'AGENT-BASE-MA14' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:OK' }, respond: { text: 'OK-OUT' } },
        { match: { systemContains: 'ROLE:DOOM' }, respond: { mode: 'error' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma14-failbranch',
      flowData: flow(
        [
          startNode('start'),
          conditionNode('cond', {
            conditions: [{ comparisonOperator: 'contains', valueToCompare: '{{input}}', valueToCompareAgainst: 'safe' }],
          }),
          platformAgentNode('okAgent', { agentId, systemPrompt: 'ROLE:OK' }),
          directReplyNode('reply', { text: 'OK-PATH-DONE' }),
          platformAgentNode('doomAgent', { agentId, systemPrompt: 'ROLE:DOOM' }),
        ],
        [
          edge('start', 'cond'),
          edge('cond', 'okAgent', 'true'),
          edge('okAgent', 'reply'),
          edge('cond', 'doomAgent', 'false'),
        ],
      ),
    })

    // risky 输入 → false 分支 → doomAgent 失败：run failed，
    // true 侧的 okAgent/reply 未执行（组合断言）
    const { status, runId } = await runFlow(request, flowId, { input: 'risky path' })
    ctx.runIds.push(runId)
    expect(status).toBe(500)
    const spans = await getSpans(request, runId)
    expect(spans.find((s) => s.nodeId === 'doomAgent')?.status).toBe('failed')
    expect(spans.find((s) => s.nodeId === 'okAgent')).toBeUndefined()
    expect(spans.find((s) => s.nodeId === 'reply')).toBeUndefined()
  })

  test('MA-15: 深层流水线 —— 5 个 Agent 接龙全执行且有序', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma15-relay', instructions: 'AGENT-BASE-MA15' })
    await setMockLlmScript({
      rules: Array.from({ length: 5 }, (_, i) => ({
        match: { systemContains: `ROLE:CHAIN-${i + 1}` },
        respond: { text: `CHAIN-OUT-${i + 1}` },
      })),
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma15-deep',
      flowData: linearFlow(
        Array.from({ length: 5 }, (_, i) =>
          platformAgentNode(`a${i + 1}`, { agentId, systemPrompt: `ROLE:CHAIN-${i + 1}` }),
        ),
      ),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '深层接龙' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    const spans = await getSpans(request, runId)
    const agentSpans = [1, 2, 3, 4, 5].map((i) => spans.find((s) => s.nodeId === `a${i}`))
    expect(agentSpans.every((s) => s?.status === 'done')).toBe(true)
    for (let i = 1; i < 5; i++) {
      expect(Date.parse(agentSpans[i - 1]!.startedAt!)).toBeLessThanOrEqual(Date.parse(agentSpans[i]!.startedAt!))
    }
    expect(body.data?.output).toMatchObject({ content: 'CHAIN-OUT-5' })
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    expect(callsOfRole(calls, 'AGENT-BASE-MA15')).toHaveLength(5)
  })

  test('MA-16: Iteration 内嵌多 Agent —— 每轮 A→B 串行且轮间不串扰', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma16-duo', instructions: 'AGENT-BASE-MA16' })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROUND:r1' }, respond: { text: 'A-OUT-r1' } },
        { match: { systemContains: 'ROUND:r2' }, respond: { text: 'A-OUT-r2' } },
        { match: { systemContains: 'ROLE:GEN-B' }, respond: { text: 'B-OUT' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma16-iter-duo',
      flowData: flow(
        [
          startNode('start'),
          iterationNode('iter', { items: ['r1', 'r2'] }),
          platformAgentNode('a', { agentId, systemPrompt: '本轮 ROUND:{{iterationItem}}' }),
          platformAgentNode('b', { agentId, systemPrompt: 'ROLE:GEN-B 接续加工' }),
        ],
        [edge('start', 'iter'), edge('iter', 'a', 'iteration'), edge('a', 'b')],
      ),
    })

    const { status, runId } = await runFlow(request, flowId, { input: '双轮双Agent' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    expect(callsOfRole(calls, 'ROUND:r1')).toHaveLength(1)
    expect(callsOfRole(calls, 'ROUND:r2')).toHaveLength(1)
    const bCalls = callsOfRole(calls, 'ROLE:GEN-B')
    expect(bCalls).toHaveLength(2)
    // 每轮 B 的输入 = 本轮 A 的产出（不串轮）
    const userTexts = bCalls.map((c) => c.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join(' '))
    expect(userTexts.some((t) => t.includes('A-OUT-r1'))).toBe(true)
    expect(userTexts.some((t) => t.includes('A-OUT-r2'))).toBe(true)

    const spans = await getSpans(request, runId)
    const iterOut = JSON.stringify(spans.find((s) => s.nodeId === 'iter')?.output)
    expect(iterOut).toContain('"completedIterations":2')
  })

  test('MA-17: Agent 接力 + 变量透传 —— start variables 进 Agent prompt', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma17-relay', instructions: 'AGENT-BASE-MA17' })
    await setMockLlmScript({
      rules: [{ match: { systemContains: '任务目标' }, respond: { text: 'GOAL-RECEIVED' } }],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma17-vars',
      flowData: linearFlow([
        startNode('start', { variables: { goal: 'GOAL-XYZ-42' } }),
        platformAgentNode('a', { agentId, systemPrompt: '任务目标:{{goal}} 全力完成' }),
      ]),
    })

    const { status, runId } = await runFlow(request, flowId, { input: '带目标出发' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    const aCall = callsOfRole(calls, '任务目标')[0]
    expect(aCall.messages.find((m) => m.role === 'system')?.content).toContain('任务目标:GOAL-XYZ-42 全力完成')
  })

  test('MA-18: 工具循环 maxIterations 封顶 —— 无死循环、有终态', async ({ request }) => {
    const agentId = await seedPlatformAgent(ctx, { name: 'ma18-looper', instructions: 'AGENT-BASE-MA18' })
    await setMockLlmScript({
      rules: [
        {
          match: { systemContains: 'ROLE:LOOPER' },
          respond: {
            mode: 'toolLoop',
            toolCalls: [{ id: 'call_spin', function: { name: 'spinner', arguments: '{}' } }],
          },
        },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma18-cap',
      flowData: linearFlow([
        toolNode('tool', {
          toolName: 'spinner',
          parameters: { type: 'object', properties: {} },
          handler: `return { tick: 1 }`,
        }),
        platformAgentNode('agent', { agentId, systemPrompt: 'ROLE:LOOPER', maxIterations: 3 }),
      ]),
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '无限循环测试' })
    ctx.runIds.push(runId)
    // 封顶后节点有终态（非死循环），输出带截断说明
    expect(status).toBe(200)
    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    expect(callsOfRole(calls, 'ROLE:LOOPER')).toHaveLength(3)
    expect(String(body.data?.output?.content)).toContain('maxIterations (3) limit')
  })

  test('WF-SMOKE: 引擎不经 LLM 的 Start→DirectReply 也能零 LLM 完成（回归锚）', async ({ request }) => {
    // 放在 MA 套件尾部做引擎健康锚：如果这条挂了，说明环境/引擎回归而非 mock 问题
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ma-smoke',
      flowData: linearFlow([directReplyNode('reply', { text: 'SMOKE-OK' })]),
    })
    const { status, body, runId } = await runFlow(request, flowId, { input: 'ping' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)
    expect(body.data?.output).toMatchObject({ content: 'SMOKE-OK' })
  })
})
