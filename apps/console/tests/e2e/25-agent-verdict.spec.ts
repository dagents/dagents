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
import { node, edge, startNode, llmNode, NODE } from './helpers/flow-builder'

/**
 * 25-agent-verdict —— R5 结构化提交裁决 e2e（2026-10-07，
 * docs/zcode-borrow/design-verdict.md §6.2）。
 *
 * 数据面走真实引擎（start → LLM 上游 → platformAgent+outputSchema），Mock
 * LLM Provider（:4010）按 userContains/systemContains 谓词编排轮次；断言三件：
 *  1. AC-R5-1：第 1 轮违规 → 同一节点内出现第二条 user 修复消息（含
 *     path/期望/实际），上游 LLM 节点零重调（恰 1 次 mock 调用）；
 *  2. AC-R5-4 e2e 面：mock（HTTP 无 sessionId）= 回放档——过程流有
 *     「会话重建」活动行 + verdict 行落 span events；
 *  3. AC-R5-6 e2e 面：恒违规 → mock 调用恰 3（预算钉死）、节点失败、
 *     span error 含 path 定位；
 *  4. AC-R5-5：inspector 出现 outputSchema json 控件；失败 run 摘要视图
 *     行内错误文本可读（canvas-result-err-inline）。
 *
 * claude 档（--resume 同会话）对照由单测 + real-cli-smoke 承担（设计 §6.2
 * 口径修正案）：HTTP mock 天然是无会话延续能力的回放档。
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
  response: { mode: string; text?: string }
}

function callsOfRole(calls: MockCall[], marker: string): MockCall[] {
  return calls.filter((c) =>
    (c.messages ?? []).some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(marker),
    ),
  )
}

async function runFlow(
  request: APIRequestContext,
  flowId: string,
  body: Record<string, unknown> = { input: 'go' },
) {
  const res = await request.post(`/api/workflows/${flowId}/run`, { data: body })
  const json = await res.json()
  // runId 走响应头（成功/失败两态都带，与 12-multi-agent 同款）
  return { status: res.status(), body: json, runId: res.headers()['x-run-id'] as string }
}

async function getSpans(request: APIRequestContext, runId: string) {
  const res = await request.get(`/api/workflows/runs/${runId}/node-spans`)
  const json = await res.json()
  return (json.data?.spans ?? []) as Array<{
    nodeId: string
    status: string
    error: string | null
    output: unknown
  }>
}

/** span.output.events 里的活动行（宽容解析）。 */
function eventsOf(output: unknown): Array<{ kind: string; label: string; detail?: string }> {
  if (!output || typeof output !== 'object') return []
  const raw = (output as Record<string, unknown>).events
  return Array.isArray(raw) ? (raw as Array<{ kind: string; label: string; detail?: string }>) : []
}

/** 裁决 schema：decision 三值枚举 + reason 必填（enum 未命中 + 必填缺失两类
 *  违规分支可同时钉住）。 */
const VERDICT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['ship', 'hold'] },
    reason: { type: 'string' },
  },
  required: ['decision', 'reason'],
})

test.describe('R5 结构化提交裁决（platformAgent outputSchema 三值裁决）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })
  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('AC-R5-1/4: 第 1 轮违规 → 节点内修复回喂（path/期望/实际）→ 第 2 轮收下；上游零重调；回放档有会话重建行', async ({
    request,
  }) => {
    test.setTimeout(90_000)
    const agentId = await seedPlatformAgent(ctx, {
      name: 'r5-verdict',
      instructions: 'R5-VERDICT-BASE',
    })
    await setMockLlmScript({
      rules: [
        // 回放档修复轮（全量 messages 重放，user 消息含违规明细）
        {
          match: { userContains: '违规明细' },
          respond: { text: '{"decision":"ship","reason":"looks good"}' },
        },
        { match: { systemContains: 'ROLE:UPSTREAM' }, respond: { text: 'UPSTREAM-OK-42' } },
        // 原始轮（尚无修复消息）
        { match: { systemContains: 'ROLE:VERDICT' }, respond: { text: '{"decision":"maybe"}' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-r5-repair',
      flowData: {
        nodes: [
          startNode('start'),
          llmNode('upstream', { model: '', systemPrompt: 'ROLE:UPSTREAM', prompt: '分析' }),
          node('agent', NODE.platformAgent, {
            agentId,
            systemPrompt: 'ROLE:VERDICT 交付裁决 JSON',
            outputSchema: VERDICT_SCHEMA,
          }),
        ],
        edges: [edge('start', 'upstream'), edge('upstream', 'agent')],
      },
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '开始裁决' })
    ctx.runIds.push(runId)
    expect(status).toBe(200)
    expect(body.success).toBe(true)

    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    // 上游零重调：修复发生在 platformAgent 节点内部，upstream 恰 1 次调用
    const upstreamCalls = callsOfRole(calls, 'ROLE:UPSTREAM')
    expect(upstreamCalls).toHaveLength(1)

    // 裁决节点恰 2 次交互：原始（违规）+ 修复回喂（合规收下）
    const agentCalls = callsOfRole(calls, 'ROLE:VERDICT')
    expect(agentCalls).toHaveLength(2)
    // 原始轮带工具声明（内置 registry）；修复轮禁用工具（防再截断）
    expect(agentCalls[0]!.tools).not.toBeNull()
    expect(agentCalls[1]!.tools).toBeNull()
    // 第 2 次请求 messages 出现第二条 user 修复消息：含 path/期望/实际 三元组
    const repairMsgs = (agentCalls[1]!.messages ?? []).filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('违规明细'),
    )
    expect(repairMsgs).toHaveLength(1)
    expect(repairMsgs[0]!.content).toContain('$.decision')
    expect(repairMsgs[0]!.content).toContain('期望')
    expect(repairMsgs[0]!.content).toContain('实际')

    // span：done + 输出带 json 字段（{{agent.json}} 可引用）+ verdict/会话重建 活动
    const spans = await getSpans(request, runId)
    const agentSpan = spans.find((s) => s.nodeId === 'agent')
    expect(agentSpan?.status).toBe('done')
    const out = agentSpan?.output as Record<string, unknown> | undefined
    expect((out?.json as Record<string, unknown>)?.decision).toBe('ship')
    const events = eventsOf(out)
    expect(events.some((e) => e.kind === 'verdict')).toBe(true)
    expect(events.some((e) => e.label.includes('第 1 轮裁决：violations'))).toBe(true)
    expect(events.some((e) => e.label.includes('第 2 轮裁决：accept'))).toBe(true)
    // AC-R5-4 e2e 面：mock（HTTP）无会话延续能力 → 回放档留「会话重建」行
    expect(events.some((e) => e.label.includes('会话重建'))).toBe(true)
  })

  test('AC-R5-6/5: 恒违规 → mock 调用恰 3、节点诚实失败（error 含 path）；inspector 有 outputSchema 控件 + 摘要行内错误可读', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const agentId = await seedPlatformAgent(ctx, {
      name: 'r5-stubborn',
      instructions: 'R5-STUBBORN-BASE',
    })
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:UPSTREAM' }, respond: { text: 'UPSTREAM-OK' } },
        { match: { systemContains: 'ROLE:STUBBORN' }, respond: { text: '{"decision":"maybe"}' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-r5-budget',
      flowData: {
        nodes: [
          startNode('start'),
          llmNode('upstream', { model: '', systemPrompt: 'ROLE:UPSTREAM', prompt: '分析' }),
          node('agent', NODE.platformAgent, {
            agentId,
            systemPrompt: 'ROLE:STUBBORN 恒不合规',
            outputSchema: VERDICT_SCHEMA,
          }),
        ],
        edges: [edge('start', 'upstream'), edge('upstream', 'agent')],
      },
    })

    const { status, body, runId } = await runFlow(request, flowId, { input: '开始' })
    ctx.runIds.push(runId)
    // 修复 + NUDGE 两轮后仍失败 → 节点被拒（R9d「节点拒绝」档：不降级收下、
    // 不伪装成功，也不整体翻红——run 终态 partial_success，同步接口 200 +
    // 显式 status）。集成裁决 2026-10-08 与 workflow-engine.md 对照表对齐。
    expect(status).toBe(200)
    expect((body as { data?: { status?: string } }).data?.status).toBe('partial_success')

    const calls = (await mockLlmCalls()) as unknown as MockCall[]
    // 预算钉死（AC-R5-6）：原始 + 修复 + NUDGE 恰 3 次，无限追问被钉死
    expect(callsOfRole(calls, 'ROLE:STUBBORN')).toHaveLength(3)

    const spans = await getSpans(request, runId)
    const agentSpan = spans.find((s) => s.nodeId === 'agent')
    expect(agentSpan?.status).toBe('rejected')
    expect(agentSpan?.error ?? '').toContain('节点被拒绝：')
    expect(agentSpan?.error ?? '').toContain('$.decision')
    const events = eventsOf(agentSpan?.output)
    expect(events.some((e) => e.label.includes('裁决预算耗尽'))).toBe(true)

    // AC-R5-5 前半：inspector 出现 outputSchema 编辑位（json 控件，注册表驱动）
    await page.goto(`/workflows/${flowId}/canvas`)
    const agentNode = page.locator('.react-flow__node[data-id="agent"]')
    await expect(agentNode).toBeVisible({ timeout: 30_000 }) // dev 冷编译放宽
    // inspector 打开手势 = 双击节点（单击只选中；flow-editor onNodeDoubleClick）
    await agentNode.dblclick()
    const inspector = page.locator('.fc-inspector')
    await expect(inspector).toBeVisible()
    const schemaField = inspector.locator('.fc-field', { hasText: 'Output Schema (JSON)' })
    await expect(schemaField).toBeVisible()
    await expect(schemaField.locator('textarea.fc-textarea')).toBeVisible()

    // AC-R5-5 后半：失败 run 摘要视图行内错误可读（含 path 违规定位）
    await page.goto(`/workflows/${flowId}/canvas?run=${runId}`)
    const errInline = page.locator('.canvas-result-err-inline').first()
    await expect(errInline).toBeVisible({ timeout: 30_000 })
    await expect(errInline).toContainText('outputSchema')
  })
})
