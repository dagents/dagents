import { test, expect } from '@playwright/test'
import {
  createSeedContext,
  seedFlow,
  seedMockLlmProvider,
  resetMockLlm,
  mockLlmCalls,
  setMockLlmScript,
  type SeedContext,
} from './helpers/seed'
import { flow, startNode, llmNode, edge } from './helpers/flow-builder'

/**
 * 断点续跑 e2e（design-run-checkpoint-resume.md §8/§10，2026-09-18）。
 *
 *   RM-01 失败→resume：已完成节点零重跑（mock LLM 调用面 = 零 token 重跑
 *        证明 —— 验收标准第 1 条的确定性落地）
 *   RM-02 拓扑护栏：图结构变更后 resume 422
 *   RM-03 HumanInput 持久挂起→应答端点→同 runId 完成
 */
test.describe('断点续跑（RM）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('RM-01: 第 3/4 节点链失败 → resume 后 mock 只收到剩余节点调用（零重跑证明）', async ({ request }) => {
    // 4 节点 LLM 链，各节点 prompt 独立可辨
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-rm01-chain',
      flowData: flow(
        [
          startNode('start'),
          llmNode('a', { systemPrompt: 'You are RM-A.', prompt: 'PA' }),
          llmNode('b', { systemPrompt: 'You are RM-B.', prompt: 'PB' }),
          llmNode('c', { systemPrompt: 'You are RM-C.', prompt: 'PC' }),
          llmNode('d', { systemPrompt: 'You are RM-D.', prompt: 'PD' }),
        ],
        [
          edge('start', 'a'),
          edge('a', 'b'),
          edge('b', 'c'),
          edge('c', 'd'),
        ],
      ),
    })

    // 首跑：C 命中空产出规则 → 节点诚实失败（WF-10 契约）
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'You are RM-C' }, respond: { text: '' } },
      ],
      fallback: { text: 'ok' },
    })
    const run1 = await request.post(`/api/workflows/${flowId}/run?async=1`, { data: { input: 'go' } })
    expect(run1.status()).toBe(200)
    const firstRunId = ((await run1.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(firstRunId)

    // 等 checkpoint resumable（真实 HTTP 栈；首跑完成失败态）
    await expect
      .poll(async () => {
        const r = await request.get(`/api/workflows/runs/${firstRunId}/checkpoint`)
        return ((await r.json()) as { data?: { status?: string } }).data?.status ?? ''
      }, { timeout: 20_000 })
      .toBe('resumable')

    // 断点证明的前半：checkpoint 记录 3 个已完成节点（start/a/b）
    const ckpt1 = ((await (await request.get(`/api/workflows/runs/${firstRunId}/checkpoint`)).json()) as {
      data: { completedNodeCount: number; failedAt: { nodeId: string } | null }
    }).data
    expect(ckpt1.completedNodeCount).toBeGreaterThanOrEqual(3)
    expect(ckpt1.failedAt?.nodeId).toBe('c')

    // 清调用记录（reset 连 script 一起清）→ 重设好规则 → resume。
    // 此后的调用面就是「零重跑证明」的观测窗。
    await resetMockLlm()
    await setMockLlmScript({ rules: [], fallback: { text: 'ok' } })
    const resume = await request.post(`/api/workflows/runs/${firstRunId}/resume`, { data: {} })
    expect(resume.status()).toBe(200)
    const secondRunId = ((await resume.json()) as { data: { runId: string; resumedFrom: string } }).data.runId
    expect(secondRunId).not.toBe(firstRunId)
    ctx.runIds.push(secondRunId)

    // 新 run 完成
    await expect
      .poll(async () => {
        const r = await request.get(`/api/workflows/runs/${secondRunId}/node-spans`)
        return ((await r.json()) as { data?: { runStatus?: string } }).data?.runStatus ?? ''
      }, { timeout: 20_000 })
      .toBe('completed')

    // ★ 零重跑证明：resume 后 mock 收到的调用只含 C/D 的 system —— A/B 零再调用
    const calls = await mockLlmCalls()
    // mock 调用记录形状：顶层 {model, messages, ...}（无 body 包裹）
    const systems = calls
      .map((c) => String((c as { messages?: Array<{ content?: string }> }).messages?.find((m) => typeof m.content === 'string' && m.content.includes('You are RM-'))?.content ?? ''))
      .filter((s) => s.includes('You are RM-'))
    const aOrB = systems.filter((s) => s.includes('RM-A') || s.includes('RM-B'))
    const cAndD = systems.filter((s) => s.includes('RM-C') || s.includes('RM-D'))
    expect(aOrB, `A/B 不应被重跑，实际收到: ${systems.join(' | ')}`).toHaveLength(0)
    expect(cAndD.length).toBeGreaterThanOrEqual(2)
  })

  test('RM-02: 拓扑变更后 resume 422 拒绝', async ({ request }) => {
    await setMockLlmScript({
      rules: [{ match: { systemContains: 'You are RM2-C' }, respond: { text: '' } }],
      fallback: { text: 'ok' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-rm02-topo',
      flowData: flow(
        [
          startNode('start'),
          llmNode('a', { systemPrompt: 'You are RM2-A.', prompt: 'P' }),
          llmNode('c', { systemPrompt: 'You are RM2-C.', prompt: 'P' }),
        ],
        [edge('start', 'a'), edge('a', 'c')],
      ),
    })
    const run = await request.post(`/api/workflows/${flowId}/run?async=1`, { data: { input: 'go' } })
    const runId = ((await run.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)
    await expect
      .poll(async () => {
        const r = await request.get(`/api/workflows/runs/${runId}/checkpoint`)
        return ((await r.json()) as { data?: { status?: string } }).data?.status ?? ''
      }, { timeout: 20_000 })
      .toBe('resumable')

    // 加节点改拓扑 → resume 必须 422
    const upd = await request.put(`/api/workflows/${flowId}`, {
      data: {
        flowData: flow(
          [
            startNode('start'),
            llmNode('a', { systemPrompt: 'You are RM2-A.', prompt: 'P' }),
            llmNode('c', { systemPrompt: 'You are RM2-C.', prompt: 'P' }),
            llmNode('z', { systemPrompt: 'You are RM2-Z.', prompt: 'P' }),
          ],
          [edge('start', 'a'), edge('a', 'c'), edge('c', 'z')],
        ),
      },
    })
    expect(upd.status()).toBe(200)

    const resume = await request.post(`/api/workflows/runs/${runId}/resume`, { data: {} })
    expect(resume.status()).toBe(422)
  })

  test('RM-03: HumanInput 持久挂起 → answer 端点 → 同 runId 完成', async ({ request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-rm03-hi',
      flowData: flow(
        [
          startNode('start'),
          { id: 'hi', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'humanInputAgentflow', label: 'hi', prompt: 'RM-03 确认方案', inputType: 'text' } },
          { id: 'd', type: 'customNode', position: { x: 220, y: 0 }, data: { name: 'directReplyAgentflow', label: 'd', directReplyMessage: 'RM3-DONE' } },
        ],
        [edge('start', 'hi'), edge('hi', 'd')],
      ),
    })
    const run = await request.post(`/api/workflows/${flowId}/run?async=1`, { data: { input: 'go' } })
    const runId = ((await run.json()) as { data: { runId: string } }).data.runId
    ctx.runIds.push(runId)

    // 挂起（非失败）
    await expect
      .poll(async () => {
        const r = await request.get(`/api/workflows/runs/${runId}/checkpoint`)
        return ((await r.json()) as { data?: { status?: string; awaiting?: { prompt: string } | null } }).data
      }, { timeout: 20_000 })
      .toMatchObject({ status: 'awaiting_input', awaiting: { prompt: 'RM-03 确认方案' } })

    const answer = await request.post(`/api/workflows/runs/${runId}/answer`, {
      data: { answer: '方案 B' },
    })
    expect(answer.status()).toBe(200)

    // 同 runId 完成 —— d 节点 span 出现
    await expect
      .poll(async () => {
        const r = await request.get(`/api/workflows/runs/${runId}/node-spans`)
        const data = ((await r.json()) as { data?: { runStatus?: string; spans?: Array<{ nodeId: string }> } }).data
        return data?.runStatus === 'completed' && (data.spans ?? []).some((s) => s.nodeId === 'd')
      }, { timeout: 20_000 })
      .toBe(true)
  })
})
