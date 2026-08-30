import { test, expect } from '@playwright/test'
import {
  createSeedContext,
  seedMockLlmProvider,
  seedFlow,
  seedDirectory,
  seedChat,
  seedMessage,
  seedPlatformAgent,
  resetMockLlm,
  setMockLlmScript,
  mockLlmCalls,
  MOCK_LLM_URL,
  type SeedContext,
} from './helpers/seed'
import {
  flow,
  edge,
  startNode,
  llmNode,
  directReplyNode,
  customFunctionNode,
  toolNode,
  httpNode,
  retrieverNode,
  executeFlowNode,
  platformAgentNode,
  parallelFlow,
  NODE,
  linearFlow,
} from './helpers/flow-builder'

/**
 * 11 — 工作流执行契约（Tier A，docs/e2e-test-plan.md §5.2 WF + §5.6 OB）。
 *
 * 驱动方式：Playwright `request`（console 代理 /api/workflows/* → gateway），
 * 不经浏览器渲染。确定性来源：seedMockLlmProvider 把 active provider 指到
 * 本地 Mock LLM（4010），所有 LLM 调用可脚本化、可在 /__control/calls 断言。
 *
 * 契约事实（workflows.ts run 路由）：
 *   POST /api/workflows/:id/run → 200 {success,data:{output,executedNodes,state}}
 *   + x-run-id 头；failed run → 500 {success:false,error,...}
 *   GET  /api/workflows/runs/:runId/node-spans → {data:{runId,spans:[{nodeId,
 *   status:'done'|'failed'|…,startedAt,finishedAt,input,output}]}}
 */
test.describe('工作流执行契约（Tier A：WF / OB）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('WF-01: 单 LLM 节点 run —— HTTP mock 生效（Phase 0 验收）', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'WF01-MOCK-REPLY' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf01',
      flowData: flow(
        [llmNode('llm1', { model: '', systemPrompt: 'You are the WF-01 smoke node.', prompt: 'say hi' })],
        [],
      ),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, {
      data: { input: 'hello wf01' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // 单节点无入边 → 该节点拿到 execute() 的 input；finalOutput = 它的输出
    expect(JSON.stringify(body.data?.output)).toContain('WF01-MOCK-REPLY')
    expect(body.data?.executedNodes?.map((n: { nodeId: string }) => n.nodeId)).toEqual(['llm1'])

    const runId = res.headers()['x-run-id']
    expect(runId).toBeTruthy()
    ctx.runIds.push(runId as string)

    // Phase 0 验收核心：确认走 HTTP mock 而非 CLI spawn——
    // mock 收到调用、model 回退到 provider 默认值、prompt 含节点配置。
    const calls = await mockLlmCalls()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const call = calls[calls.length - 1]
    expect(call.model).toBe('e2e-mock')
    const messages = call.messages as Array<{ role: string; content: string }>
    expect(messages.some((m) => m.role === 'system' && m.content.includes('WF-01'))).toBe(true)
    expect(messages.some((m) => m.role === 'user' && m.content.includes('say hi'))).toBe(true)
  })

  test('WF-02: Start→LLM→DirectReply 全链 —— finalOutput 取拓扑最深节点', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'WF02-LLM-TEXT' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf02',
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are WF-02.', prompt: 'draft' }),
        directReplyNode('reply', { text: 'WF02-FINAL-REPLY' }),
      ]),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, {
      data: { input: 'go wf02' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    ctx.runIds.push(res.headers()['x-run-id'] as string)

    // DirectReply 拓扑序最深 → finalOutput = {content: 'WF02-FINAL-REPLY'}
    expect(body.data?.output).toMatchObject({ content: 'WF02-FINAL-REPLY' })
    expect(new Set(body.data?.executedNodes?.map((n: { nodeId: string }) => n.nodeId))).toEqual(
      new Set(['start', 'llm1', 'reply']),
    )
  })

  test('WF-03: CustomFunction 纯计算节点 —— 不触发任何 LLM 调用', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'should-not-be-called' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf03',
      flowData: linearFlow([
        customFunctionNode('calc', {
          // $input 是上游（start）输出的 content 字符串
          code: `return { content: 'WF03-CF:' + ($input ?? '').length }`,
        }),
      ]),
    })

    const callsBefore = (await mockLlmCalls()).length
    const res = await request.post(`/api/workflows/${flowId}/run`, {
      data: { input: 'abcdef' },
    })
    expect(res.status()).toBe(200)
    ctx.runIds.push(res.headers()['x-run-id'] as string)

    const body = await res.json()
    expect(JSON.stringify(body.data?.output)).toContain('WF03-CF:6')
    // 纯计算路径零 LLM 调用
    expect((await mockLlmCalls()).length).toBe(callsBefore)
  })

  test('OB-01: run + spans 落库 —— runs 行与逐节点 span 行', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'OB01-TEXT' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ob01',
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are OB-01.', prompt: 'p' }),
        directReplyNode('reply', { text: 'OB01-FINAL' }),
      ]),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, {
      data: { input: 'ob01' },
    })
    expect(res.status()).toBe(200)
    const runId = res.headers()['x-run-id'] as string
    ctx.runIds.push(runId)

    const { records: runRows } = await ctx.db.runQuery<{
      status: string
      input: unknown
      output: unknown
      pipeline_id: string
      duration_ms: number | null
    }>(`SELECT status, input, output, pipeline_id, duration_ms FROM runs WHERE id = $1`, [runId])
    expect(runRows).toHaveLength(1)
    expect(runRows[0].status).toBe('completed')
    expect(runRows[0].pipeline_id).toBe(flowId)
    expect(JSON.stringify(runRows[0].output)).toContain('OB01-FINAL')
    expect(JSON.stringify(runRows[0].input)).toContain('ob01')

    const { records: spanRows } = await ctx.db.runQuery<{ node_id: string; status: string; duration_ms: number | null }>(
      `SELECT node_id, status, duration_ms FROM run_node_spans WHERE run_id = $1 ORDER BY node_id`,
      [runId],
    )
    expect(new Set(spanRows.map((r) => r.node_id))).toEqual(new Set(['start', 'llm1', 'reply']))
    expect(spanRows.every((r) => r.status === 'done')).toBe(true)
    expect(spanRows.every((r) => r.duration_ms != null && r.duration_ms >= 0)).toBe(true)
  })

  test('OB-02: node-spans API —— 返回全部执行节点', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'OB02-TEXT' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ob02',
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are OB-02.', prompt: 'p' }),
        directReplyNode('reply', { text: 'OB02-FINAL' }),
      ]),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, {
      data: { input: 'ob02' },
    })
    const runId = res.headers()['x-run-id'] as string
    ctx.runIds.push(runId)

    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    expect(spansRes.status()).toBe(200)
    const spansBody = await spansRes.json()
    expect(spansBody.success).toBe(true)
    expect(spansBody.data?.runId).toBe(runId)

    const spans = spansBody.data?.spans as Array<{
      nodeId: string
      status: string
      startedAt: string | null
      finishedAt: string | null
      input: unknown
      output: unknown
    }>
    expect(new Set(spans.map((s) => s.nodeId))).toEqual(new Set(['start', 'llm1', 'reply']))
    expect(spans.every((s) => s.status === 'done')).toBe(true)
    expect(spans.every((s) => s.startedAt != null && s.finishedAt != null)).toBe(true)
    // input/output 已持久化（llm1 的输出含 mock 文本）
    const llmSpan = spans.find((s) => s.nodeId === 'llm1')
    expect(JSON.stringify(llmSpan?.output)).toContain('OB02-TEXT')
  })

  test('WF-04: HTTP 节点 —— 指向 mock echo 端点 + 非 http(s) URL 报错', async ({ request }) => {
    // 正向：GET mock 健康端点，JSON 响应被直接 parse 成输出对象
    const okFlowId = await seedFlow(ctx, request, {
      name: 'e2e-wf04-ok',
      flowData: linearFlow([httpNode('http1', { url: `${MOCK_LLM_URL}/__control/health`, method: 'GET' })]),
    })
    const okRun = await request.post(`/api/workflows/${okFlowId}/run`, { data: { input: 'wf04' } })
    ctx.runIds.push(okRun.headers()['x-run-id'] as string)
    expect(okRun.status()).toBe(200)
    const okBody = await okRun.json()
    expect(okBody.data?.output?.ok).toBe(true)

    // 负向：scheme 白名单拒绝非 http(s)
    const badFlowId = await seedFlow(ctx, request, {
      name: 'e2e-wf04-bad',
      flowData: linearFlow([httpNode('http1', { url: 'ftp://example.com/nope' })]),
    })
    const badRun = await request.post(`/api/workflows/${badFlowId}/run`, { data: { input: 'wf04' } })
    ctx.runIds.push(badRun.headers()['x-run-id'] as string)
    expect(badRun.status()).toBe(500)
    expect(String((await badRun.json()).error)).toContain('http')
  })

  test('WF-05: Retriever 节点 —— 聊天历史关键词检索', async ({ request }) => {
    const directoryId = await seedDirectory(ctx)
    const chatId = await seedChat(ctx, { directoryId })
    await seedMessage(ctx, { chatId, role: 'user', content: '今天讨论 needle-word-e2e 部署方案' })
    await seedMessage(ctx, { chatId, role: 'assistant', content: '无关消息，不含关键词' })

    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf05-retriever',
      flowData: linearFlow([retrieverNode('retr', { query: 'needle-word-e2e 部署', topK: 3 })]),
    })

    // chatId 经 run body 传入 —— historyRetriever 按 chat 检索
    const res = await request.post(`/api/workflows/${flowId}/run`, {
      data: { input: '检索', chatId },
    })
    ctx.runIds.push(res.headers()['x-run-id'] as string)
    expect(res.status()).toBe(200)
    const body = await res.json()
    const docs = body.data?.output?.docs as Array<{ content: string }>
    expect(Array.isArray(docs)).toBe(true)
    expect(docs.some((d) => d.content.includes('needle-word-e2e'))).toBe(true)
    expect(docs.every((d) => !d.content.includes('无关消息'))).toBe(true)
  })

  test('WF-06: Tool 节点 handler 直接执行 —— 无 Agent 参与时结果进输出', async ({ request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf06-tool',
      flowData: linearFlow([
        toolNode('tool', {
          toolName: 'adder',
          toolDescription: '加法',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
          },
          toolInput: { a: 2, b: 3 },
          handler: `return $input.a + $input.b`,
        }),
      ]),
    })

    const callsBefore = (await mockLlmCalls()).length
    const res = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'wf06' } })
    ctx.runIds.push(res.headers()['x-run-id'] as string)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data?.output).toMatchObject({ toolName: 'adder', result: { value: 5 }, registered: true })
    // 无 Agent：零 LLM 调用
    expect((await mockLlmCalls()).length).toBe(callsBefore)
  })

  test('WF-07: 变量解析 —— start variables 与 input 都展开进 prompt', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'WF07-OK' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf07-vars',
      flowData: flow(
        [
          startNode('start', { variables: { goal: 'G-777' } }),
          llmNode('llm1', { systemPrompt: 'You are WF-07.', prompt: 'goal={{goal}} input={{input}}' }),
        ],
        [edge('start', 'llm1')],
      ),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'IN-991' } })
    ctx.runIds.push(res.headers()['x-run-id'] as string)
    expect(res.status()).toBe(200)

    const calls = (await mockLlmCalls()) as Array<{ messages: Array<{ role: string; content: string }> }>
    const last = calls[calls.length - 1]
    const user = last.messages.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('goal=G-777 input=IN-991')
  })

  test('WF-08: 配置双形态兼容 —— 平铺 vs 嵌套 data.inputs 结果一致', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'WF08-SAME-ANSWER' } })
    // 平铺形态：配置直接在 data 上
    const flatId = await seedFlow(ctx, request, {
      name: 'e2e-wf08-flat',
      flowData: flow(
        [
          {
            id: 'llm1',
            type: 'customNode',
            position: { x: 0, y: 0 },
            data: { name: NODE.llm, label: 'llm1', model: '', systemPrompt: 'You are WF-08.', prompt: 'flat form' },
          },
        ],
        [],
      ),
    })
    // 嵌套形态：画布保存的 data.inputs.<field>
    const nestedId = await seedFlow(ctx, request, {
      name: 'e2e-wf08-nested',
      flowData: flow(
        [
          {
            id: 'llm1',
            type: 'customNode',
            position: { x: 0, y: 0 },
            data: {
              name: NODE.llm,
              label: 'llm1',
              inputs: { model: '', systemPrompt: 'You are WF-08.', prompt: 'nested form' },
            },
          },
        ],
        [],
      ),
    })

    const flatRun = await request.post(`/api/workflows/${flatId}/run`, { data: { input: 'wf08' } })
    const nestedRun = await request.post(`/api/workflows/${nestedId}/run`, { data: { input: 'wf08' } })
    ctx.runIds.push(flatRun.headers()['x-run-id'] as string)
    ctx.runIds.push(nestedRun.headers()['x-run-id'] as string)
    expect(flatRun.status()).toBe(200)
    expect(nestedRun.status()).toBe(200)

    const flatOut = (await flatRun.json()).data?.output
    const nestedOut = (await nestedRun.json()).data?.output
    expect(flatOut).toMatchObject({ content: 'WF08-SAME-ANSWER' })
    expect(nestedOut).toEqual(flatOut)
  })

  test('OB-03: 失败 run 的 spans —— failed 节点带 error，未执行节点无 span', async ({ request }) => {
    await setMockLlmScript({
      rules: [{ match: { systemContains: 'You are OB-03-FAIL' }, respond: { mode: 'error' } }],
      fallback: { text: 'should-not-run' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ob03-fail',
      flowData: linearFlow([
        llmNode('badllm', { systemPrompt: 'You are OB-03-FAIL.', prompt: 'boom' }),
        directReplyNode('reply', { text: 'OB03-UNREACHED' }),
      ]),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'ob03' } })
    ctx.runIds.push(res.headers()['x-run-id'] as string)
    expect(res.status()).toBe(500)

    const { records: runRows } = await ctx.db.runQuery<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [ctx.runIds[ctx.runIds.length - 1]],
    )
    expect(runRows[0]?.status).toBe('failed')

    const spansRes = await request.get(`/api/workflows/runs/${ctx.runIds[ctx.runIds.length - 1]}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{ nodeId: string; status: string; error: string | null }>
    const bad = spans.find((s) => s.nodeId === 'badllm')
    expect(bad?.status).toBe('failed')
    expect(bad?.error ?? '').toContain('LLM API error')
    // 下游被剪枝：无 span
    expect(spans.find((s) => s.nodeId === 'reply')).toBeUndefined()
  })

  test('OB-04: 子流程 span 合并 —— 父 run 的 node-spans 含子流程节点', async ({ request }) => {
    // 子流程纯计算（零 LLM），节点 id 独立命名避免 span 冲突
    const subId = await seedFlow(ctx, request, {
      name: 'e2e-ob04-sub',
      flowData: flow(
        [
          startNode('ob4SubStart'),
          customFunctionNode('ob4SubCalc', { code: `return { content: 'OB04-SUB-OUT' }` }),
        ],
        [edge('ob4SubStart', 'ob4SubCalc')],
      ),
    })
    const parentId = await seedFlow(ctx, request, {
      name: 'e2e-ob04-parent',
      flowData: flow(
        [startNode('start'), executeFlowNode('ef', { flowId: subId })],
        [edge('start', 'ef')],
      ),
    })

    const res = await request.post(`/api/workflows/${parentId}/run`, { data: { input: 'ob04' } })
    const runId = res.headers()['x-run-id'] as string
    ctx.runIds.push(runId)
    expect(res.status()).toBe(200)

    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{ nodeId: string; status: string }>
    // 子流程的 start/calc 都以父 run 的 span 集合出现
    expect(spans.find((s) => s.nodeId === 'ob4SubStart')?.status).toBe('done')
    expect(spans.find((s) => s.nodeId === 'ob4SubCalc')?.status).toBe('done')
    // 子流程输出经 ExecuteFlow 进入父流（ef 是父流拓扑最深 → finalOutput）
    expect((await res.json()).data?.output?.content).toBe('OB04-SUB-OUT')
  })

  test('OB-05: 多 Agent run 的 token 累计 —— 各节点 usage 落 span', async ({ request }) => {
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:OB5-A' }, respond: { text: 'OB5-A-OUT' } },
        { match: { systemContains: 'ROLE:OB5-B' }, respond: { text: 'OB5-B-OUT' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const agentId = await seedPlatformAgent(ctx, { name: 'ob05-duo', instructions: 'AGENT-BASE-OB5' })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ob05-tokens',
      flowData: parallelFlow([
        [platformAgentNode('a', { agentId, systemPrompt: 'ROLE:OB5-A' })],
        [platformAgentNode('b', { agentId, systemPrompt: 'ROLE:OB5-B' })],
      ]),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'ob05' } })
    const runId = res.headers()['x-run-id'] as string
    ctx.runIds.push(runId)
    expect(res.status()).toBe(200)

    // mock 每次调用回报 usage {10,5,15}；PlatformAgent 单次调用 → span.tokens
    // 落该值（runs 表无 token 列，span 层是 token 事实的载体）。
    // 增量 span 落库是 fire-and-forget（不阻塞执行波），sync run 返回时行
    // 可能尚未可见 —— 轮询等待而不是单次查询（此前 ~1/3 概率闪失败）。
    const bothTokensReady = async (): Promise<boolean> => {
      const { records: spans } = await ctx.db.runQuery<{ node_id: string; tokens: unknown }>(
        `SELECT node_id, tokens FROM run_node_spans WHERE run_id = $1`,
        [runId],
      )
      return ['a', 'b'].every((id) => {
        const tokens = spans.find((s) => s.node_id === id)?.tokens as {
          total_tokens?: number
        } | null
        return tokens?.total_tokens === 15
      })
    }
    const deadline = Date.now() + 5_000
    while (!(await bothTokensReady())) {
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 200))
    }

    const { records: spans } = await ctx.db.runQuery<{ node_id: string; tokens: unknown }>(
      `SELECT node_id, tokens FROM run_node_spans WHERE run_id = $1`,
      [runId],
    )
    for (const nodeId of ['a', 'b']) {
      const tokens = spans.find((s) => s.node_id === nodeId)?.tokens as {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      } | null
      expect(tokens?.total_tokens).toBe(15)
      expect(tokens?.prompt_tokens).toBe(10)
      expect(tokens?.completion_tokens).toBe(5)
    }
  })

  test('OB-06: 审计日志 —— flow 创建/删除触发 audit 行', async ({ request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ob06-audit',
      flowData: flow([llmNode('llm1', { systemPrompt: 'You are OB-06.', prompt: 'p' })], []),
    })

    // 创建：action=workflow.create，target 指向该 flow
    const { records: created } = await ctx.db.runQuery<{ action: string; target_id: string }>(
      `SELECT action, target_id FROM audit_log WHERE target_type = 'workflow' AND target_id = $1 ORDER BY created_at DESC`,
      [flowId],
    )
    expect(created.some((r) => r.action === 'workflow.create')).toBe(true)

    // 删除：action=workflow.delete（注意先记 runId 清理依赖 —— 这里不 run，直接删）
    ctx.flowIds = ctx.flowIds.filter((id) => id !== flowId)
    const del = await request.delete(`/api/workflows/${flowId}`)
    expect(del.status()).toBe(200)
    const { records: deleted } = await ctx.db.runQuery<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_type = 'workflow' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [flowId],
    )
    expect(deleted[0]?.action).toBe('workflow.delete')
    // 注：run 路由不写 audit（审计只覆盖 CRUD 变更），与 docs/workflow-engine.md 一致
  })

  // ── WF-09 ~ WF-11：多上游合并 + 空产出守卫 ────────────────────────────────
  // 2026-08-27 真实复跑「产品发现（并行）」暴露：mergeInputs 把 N 份上游拼进
  // content，而 LLM 节点只读被 Object.assign 覆盖的 text（只剩最后一条），
  // 汇总节点丢 3/4 简报；且空产出被标记 done。mock 单链路测不出——
  // 必须 N 进 1 拓扑 + 断言 sink 的 prompt 含全部上游。

  test('WF-09: 菱形合并 —— N 进 1 LLM 节点收到全部上游产出', async ({ request }) => {
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'MERGE-A' }, respond: { text: 'WF07-BRIEF-A' } },
        { match: { systemContains: 'MERGE-B' }, respond: { text: 'WF07-BRIEF-B' } },
        { match: { systemContains: 'MERGE-SINK' }, respond: { text: 'WF07-MERGED' } },
      ],
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf07-merge',
      flowData: flow(
        [
          startNode('start', { input: 'merge-go' }),
          llmNode('branchA', { systemPrompt: 'You are MERGE-A.', prompt: 'draft a' }),
          llmNode('branchB', { systemPrompt: 'You are MERGE-B.', prompt: 'draft b' }),
          llmNode('sink', { systemPrompt: 'You are MERGE-SINK.', prompt: 'integrate' }),
          directReplyNode('reply', { text: 'WF07-FINAL' }),
        ],
        [
          edge('start', 'branchA'),
          edge('start', 'branchB'),
          edge('branchA', 'sink'),
          edge('branchB', 'sink'),
          edge('sink', 'reply'),
        ],
      ),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, { data: {} })
    expect(res.status()).toBe(200)
    const runId = res.headers()['x-run-id'] as string
    ctx.runIds.push(runId)

    // 回归本体：sink 节点的 span input.prompt 必须同时含两份上游简报
    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{
      nodeId: string
      status: string
      input: unknown
    }>
    const sink = spans.find((s) => s.nodeId === 'sink')
    expect(sink?.status).toBe('done')
    const sinkPrompt = JSON.stringify(sink?.input ?? {})
    expect(sinkPrompt).toContain('WF07-BRIEF-A')
    expect(sinkPrompt).toContain('WF07-BRIEF-B')

    // 双保险：mock 侧 sink 调用的 user 消息同样两份齐全
    const calls = await mockLlmCalls()
    const sinkCall = [...calls]
      .reverse()
      .find((c) => JSON.stringify(c).includes('MERGE-SINK'))
    const sinkUser = JSON.stringify(sinkCall ?? {})
    expect(sinkUser).toContain('WF07-BRIEF-A')
    expect(sinkUser).toContain('WF07-BRIEF-B')
  })

  test('WF-10: LLM 空产出 —— 节点诚实失败而非空成功', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: '' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf08-empty',
      flowData: flow(
        [
          startNode('start', { input: 'go' }),
          llmNode('llm1', { systemPrompt: 'You are WF-08.', prompt: 'say something' }),
        ],
        [edge('start', 'llm1')],
      ),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, { data: {} })
    ctx.runIds.push(res.headers()['x-run-id'] as string)
    // 引擎失败 → 500 + error 指明原因（修复前：200 且 content 为空的假成功）
    expect(res.status()).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(String(body.error)).toContain('返回空内容')

    const runId = ctx.runIds[ctx.runIds.length - 1]
    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{
      nodeId: string
      status: string
      error: string | null
    }>
    const bad = spans.find((s) => s.nodeId === 'llm1')
    expect(bad?.status).toBe('failed')
    expect(bad?.error ?? '').toContain('返回空内容')
  })

  test('WF-11: PlatformAgent 空产出 —— 同款诚实失败', async ({ request }) => {
    // 与 WF-08 同契约但走 Agent 路径：mock 返回空正文 → 节点失败（此前
    // 真实复跑中 Agent 0 字正文仍标 done 的假成功）。
    await setMockLlmScript({ fallback: { text: '' } })
    const agentId = await seedPlatformAgent(ctx, { name: 'wf09-empty', instructions: 'WF09-BASE' })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf09-empty-agent',
      flowData: linearFlow([platformAgentNode('agent1', { agentId })]),
    })

    const res = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'go' } })
    ctx.runIds.push(res.headers()['x-run-id'] as string)
    expect(res.status()).toBe(500)
    const body = await res.json()
    expect(String(body.error)).toContain('返回空内容')

    const runId = ctx.runIds[ctx.runIds.length - 1]
    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{
      nodeId: string
      status: string
      error: string | null
    }>
    const bad = spans.find((s) => s.nodeId === 'agent1')
    expect(bad?.status).toBe('failed')
    expect(bad?.error ?? '').toContain('返回空内容')
  })

  // ── WF-12: 列表页「运行」UI 旅程 —— 输入面板 → 异步详情旁观 ────────────
  // 2026-08-29 修复回归钉：此前列表运行按钮 POST 同步端点，响应要等整个
  // 流程跑完才返回（用户感知「点了没反应」）。现在：按钮先开输入对话框，
  // 提交走 ?async=1 立即打开详情页，进度由 node-spans 轮询涂染，终态 toast。
  test('WF-12: list run button → input dialog → async detail watch', async ({ page, request }) => {
    await setMockLlmScript({ fallback: { text: 'WF12-LIST-RUN-REPLY' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf12-list-run',
      flowData: flow(
        [llmNode('llm1', { model: '', systemPrompt: 'You are the WF-12 list-run node.', prompt: 'say hi' })],
        [],
      ),
    })

    await page.goto('/')
    const card = page.locator('.flow-card', { hasText: 'e2e-wf12-list-run' })
    await expect(card).toBeVisible({ timeout: 15_000 })

    // 点「运行」→ 输入对话框（不再直接发起同步运行）
    await card.getByRole('button', { name: /^运行$/ }).click()
    const dialog = page.locator('.modal-dialog.open')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-label', '运行输入')
    await dialog.locator('textarea').fill('wf12 list-run input')

    // 提交 → 对话框关闭 + 详情页立即打开（异步 —— 不等流程跑完）
    await dialog.getByRole('button', { name: '开始运行' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.flow-detail-page.active')).toBeVisible({ timeout: 5_000 })

    // 详情页轮询到终态 → 运行完成 toast（mock LLM 秒回）
    await expect(page.getByText('运行完成').first()).toBeVisible({ timeout: 30_000 })
  })

  // ── WF-13: 节点流式产出 —— running 态 span.output 可见 partial（2026-08-30）──
  // 链路：LLM 节点流式门控放宽（不再要求末节点+SSE）→ onNodeDelta →
  // span-writer 节流落库（1s）→ node-spans 轮询端在读到终态前看到增量文本，
  // 且终态全文覆盖 partial（running 守卫不破坏 onNodeEnd 语义）。
  test('WF-13: node output streams into run_node_spans while running', async ({ request }) => {
    const FULL = 'WF13-STREAM-' + 'x'.repeat(120)
    // 120 字符 / 4 字节每帧 = 30 帧 × 150ms ≈ 4.5s 生成窗口
    await setMockLlmScript({ fallback: { text: FULL, streamChunkSize: 4, streamIntervalMs: 150 } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-wf13-stream',
      flowData: flow(
        [llmNode('llm1', { model: '', systemPrompt: 'You are the WF-13 streaming node.', prompt: 'p' })],
        [],
      ),
    })

    const res = await request.post(`/api/workflows/${flowId}/run?async=1`, { data: {} })
    expect(res.status()).toBe(200)
    const runId = ((await res.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)

    // 中途轮询：捕获「running 且已有 partial」的观察点
    let sawRunningPartial = false
    let terminalOutput = ''
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
      const body = (await spansRes.json()) as {
        data?: {
          runStatus?: string | null
          spans?: Array<{ nodeId: string; status: string; output?: { text?: string } | null }>
        }
      }
      const span = body.data?.spans?.find((s) => s.nodeId === 'llm1')
      if (span && span.status === 'running') {
        const partial = span.output?.text ?? ''
        if (partial.length > 0 && partial.length < FULL.length) sawRunningPartial = true
      }
      const runStatus = body.data?.runStatus
      if (runStatus === 'completed' || runStatus === 'failed') {
        terminalOutput = span?.output?.text ?? ''
        break
      }
      await new Promise((r) => setTimeout(r, 400))
    }

    expect(sawRunningPartial).toBe(true)
    expect(terminalOutput).toBe(FULL)
  })
})
