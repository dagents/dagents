import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  createSeedContext,
  seedMockLlmProvider,
  seedFlow,
  resetMockLlm,
  setMockLlmScript,
  MOCK_LLM_URL,
  type SeedContext,
} from './helpers/seed'
import {
  flow,
  edge,
  startNode,
  llmNode,
  platformAgentNode,
  customFunctionNode,
  iterationNode,
  loopNode,
  httpNode,
  linearFlow,
} from './helpers/flow-builder'

/**
 * 14 — 失败与边界（Tier D，docs/e2e-test-plan.md §5.5 ED-01~08）。
 *
 * ED-06（ExecuteFlow 4 层嵌套）已在 12-multi-agent MA-08 覆盖；
 * ED-07（LLM 无超时挂起）是 docs/workflow-engine.md 已知限制，P2 默认
 * skip；ED-08（SSE 中断恢复）归入 TR-05 的「服务不崩」回归锚。
 */

async function runFlow(request: APIRequestContext, flowId: string, body: Record<string, unknown> = { input: 'go' }) {
  const res = await request.post(`/api/workflows/${flowId}/run`, { data: body })
  const json = await res.json()
  return { status: res.status(), body: json, runId: res.headers()['x-run-id'] as string }
}

test.describe('失败与边界（Tier D：ED）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })
  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('ED-01: 无效 flow id / 不存在 flow —— 明确 400/404，不 500 不挂起', async ({ request }) => {
    const bad = await request.post('/api/workflows/not-a-uuid/run', { data: { input: 'x' } })
    expect(bad.status()).toBe(400)
    // console 代理层先于 gateway 校验，报「invalid workflow id」
    expect(String((await bad.json()).error)).toContain('invalid workflow id')

    const missing = await request.post(`/api/workflows/${randomUUID()}/run`, { data: { input: 'x' } })
    expect(missing.status()).toBe(404)
    expect(String((await missing.json()).error)).toContain('not found')
  })

  test('ED-01b: 空 nodes flow —— 确定性空跑（不挂起、明确终态）', async ({ request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ed01-empty',
      flowData: { nodes: [], edges: [] },
    })
    const { status, body } = await runFlow(request, flowId)
    // 引擎对空 DAG 的真实行为：成功完成、无执行节点（e2e 钉住）
    expect(status).toBe(200)
    expect(body.data?.executedNodes).toEqual([])
  })

  test('ED-02: PlatformAgent 引用不存在的 agent —— 节点失败 + 错误含 agentId', async ({ request }) => {
    await setMockLlmScript({ fallback: { text: 'unused' } })
    const ghostId = randomUUID()
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ed02-ghost',
      flowData: linearFlow([platformAgentNode('ghost', { agentId: ghostId, systemPrompt: 'ROLE:GHOST' })]),
    })

    const { status, body, runId } = await runFlow(request, flowId)
    ctx.runIds.push(runId)
    expect(status).toBe(500)
    expect(String(body.error)).toContain(ghostId)

    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{ nodeId: string; status: string; error: string | null }>
    const ghost = spans.find((s) => s.nodeId === 'ghost')
    expect(ghost?.status).toBe('failed')
    expect(ghost?.error ?? '').toContain('not found')
  })

  test('ED-03: Iteration 超 100 项截断 —— 只跑 100 轮', async ({ request }) => {
    const items = Array.from({ length: 150 }, (_, i) => `item-${i}`)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ed03-cap',
      flowData: flow(
        [
          startNode('start'),
          iterationNode('iter', { items }),
          customFunctionNode('work', { code: `return { content: 'W-' + String($input).slice(5, 8) }` }),
        ],
        [edge('start', 'iter'), edge('iter', 'work', 'iteration')],
      ),
    })

    const { status, runId } = await runFlow(request, flowId)
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{ nodeId: string; output: unknown }>
    const iterOut = JSON.stringify(spans.find((s) => s.nodeId === 'iter')?.output)
    expect(iterOut).toContain('"completedIterations":100')
    // 第 101~150 项被截断，不执行
    expect(JSON.parse(`{${iterOut.slice(1, -1)}}`).iterations).toHaveLength(100)
  })

  test('ED-04: Loop 超硬上限 —— MAX_LOOP_COUNT 截断，无死循环', async ({ request }) => {
    // 请求 50 轮（上限 10），body 不满足 break 条件 → 必然触顶
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ed04-loopcap',
      flowData: flow(
        [
          startNode('start'),
          loopNode('loop', { maxIterations: 50, condition: '$flow.state.done === true' }),
          customFunctionNode('work', { code: `return { content: 'R' }` }),
        ],
        [edge('start', 'loop'), edge('loop', 'work', 'loop')],
      ),
    })

    const { status, runId, body } = await runFlow(request, flowId)
    ctx.runIds.push(runId)
    expect(status).toBe(200)

    const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
    const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{ nodeId: string; output: unknown }>
    const loopSpan = spans.find((s) => s.nodeId === 'loop')
    const loopOut = JSON.parse(`{${JSON.stringify(spans.find((s) => s.nodeId === 'loop')?.output).slice(1, -1)}}`)
    // 引擎在 LoopNode 内钳到 MAX_LOOP_COUNT(10)：completedIterations=10
    expect(loopOut.loopCount).toBe(10)
    expect(loopOut.completedIterations).toBe(10)
    expect(loopOut.iterations).toHaveLength(10)
  })

  test('ED-05: 并发 run 同一 flow —— 两个 run 各自完整、run_id 隔离', async ({ request }) => {
    await setMockLlmScript({
      rules: [{ match: { systemContains: 'You are ED-05' }, respond: { text: 'ED05-OUT', delayMs: 150 } }],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ed05-concurrent',
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are ED-05.', prompt: 'p' }),
      ]),
    })

    const [a, b] = await Promise.all([
      runFlow(request, flowId, { input: 'run-a' }),
      runFlow(request, flowId, { input: 'run-b' }),
    ])
    ctx.runIds.push(a.runId, b.runId)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.runId).not.toBe(b.runId)

    // 各自的 span 集独立完整
    for (const runId of [a.runId, b.runId]) {
      const spansRes = await request.get(`/api/workflows/runs/${runId}/node-spans`)
      const spans = ((await spansRes.json()).data?.spans ?? []) as Array<{ nodeId: string; status: string }>
      expect(new Set(spans.map((s) => s.nodeId))).toEqual(new Set(['start', 'llm1']))
      expect(spans.every((s) => s.status === 'done')).toBe(true)
    }

    // 各自的 runs 行独立
    const { records } = await ctx.db.runQuery<{ id: string; status: string }>(
      `SELECT id, status FROM runs WHERE id = ANY($1::uuid[])`,
      [[a.runId, b.runId]],
    )
    expect(records).toHaveLength(2)
    expect(records.every((r) => r.status === 'completed')).toBe(true)
  })

  test('ED-07: HTTP 节点 15s 超时路径 —— 挂起端点被超时切断，run 有终态', async ({ request }) => {
    test.setTimeout(40_000)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ed07-timeout',
      flowData: linearFlow([httpNode('hang', { url: `${MOCK_LLM_URL}/__control/hang` })]),
    })

    const startedAt = Date.now()
    const { status, body, runId } = await runFlow(request, flowId)
    ctx.runIds.push(runId)
    const elapsed = Date.now() - startedAt

    // 引擎对 HTTP 节点有 15s 硬超时（workflow-clients HTTP_TOOL_TIMEOUT_MS）：
    // 挂起端点不会永远吊着 run —— 节点失败、run failed、有明确终态
    expect(status).toBe(500)
    expect(elapsed).toBeGreaterThanOrEqual(14_000)
    expect(elapsed).toBeLessThan(35_000)
    expect(String(body.error)).toBeTruthy()
  })
})

// ─── 已知限制与真实 CLI 冒烟（默认关） ─────────────────────────────────────

test.describe('ED-07b/CLI-SMOKE：文档化限制与真实 CLI 冒烟（默认 skip）', () => {
  // ED-07 的 LLM 挂起分支：引擎对 LLM fetch 无超时（docs/workflow-engine.md
  // 已知限制），run 会一直吊到客户端超时 —— 无法确定性 e2e，保持 skip 并
  // 引用文档；HTTP 节点的 15s 超时已在上方 ED-07 覆盖。
  test.skip('ED-07b: LLM 挂起（HTTP LLM 已有 LLM_HTTP_TIMEOUT_MS，但 e2e 无法调低它）', async () => {
    // 超时已存在（2026-08-22 起非流式总预算/流式空闲看门狗），skip 原因
    // 变为：gateway 由 playwright 外部复用启动，测试内无法注入更低的
    // LLM_HTTP_TIMEOUT_MS，按真实 120s 等待又过长。可启用条件：gateway
    // 支持 env 热调或专用测试实例 —— mock respond.mode:'hang' + 断言 run
    // 在超时后 failed。实现见 docs/e2e-test-plan.md §5.5 ED-07。
  })

  // 真实 CLI 冒烟（P2，本机装了 claude 时手动开）：验证 CLI-first 兜底路径
  // —— 不 seed mock provider，无 active provider 时节点 spawn 本地 CLI。
  test.skip(!process.env.E2E_REAL_CLI, 'CLI-SMOKE：需 E2E_REAL_CLI=1 且本机安装 claude')
  test('CLI-SMOKE: 无 provider 时 LLM 节点跑本地 CLI', async ({ request }) => {
    const ctx = await createSeedContext()
    test.setTimeout(240_000) // CLI 首跑可能慢
    try {
      const flowId = await seedFlow(ctx, request, {
        name: 'e2e-cli-smoke',
        flowData: linearFlow([llmNode('solo', { systemPrompt: 'You are a smoke test.', prompt: 'Reply with the single word: OK' })]),
      })
      const res = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'smoke' } })
      ctx.runIds.push(res.headers()['x-run-id'] as string)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(String(body.data?.output?.content ?? '').length).toBeGreaterThan(0)
    } finally {
      await ctx.dispose()
    }
  })
})
