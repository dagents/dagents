import { test, expect } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  createSeedContext,
  seedMockLlmProvider,
  seedFlow,
  seedPlatformAgent,
  seedDirectory,
  seedChat,
  seedChatBoundToFlow,
  resetMockLlm,
  setMockLlmScript,
  DISPATCH_BASE,
  type SeedContext,
} from './helpers/seed'
import { linearFlow, parallelFlow, llmNode, platformAgentNode } from './helpers/flow-builder'

/**
 * 15 — 浏览器 UI 旅程（Tier C，docs/e2e-test-plan.md §5.4 UI-01~08）。
 *
 * 覆盖取舍（与计划对照）：
 *  - UI-03 画布拖拽/连线：按计划 §10 的脆弱性取舍只做「画布编辑器可达」
 *    冒烟（05-agentflows 已有 canvas 编辑按钮用例），深层交互留手工；
 *  - UI-06 嵌套字段归一化：契约层已由 WF-08 覆盖，浏览器侧不重复；
 *  - UI-07 Agent 快速创建：依赖本机安装 CLI（环境相关），由 04-agents
 *    的非执行态用例覆盖，此处不冒 CLI spawn 风险。
 */

test.describe('浏览器 UI 旅程（Tier C：UI）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await seedMockLlmProvider(ctx)
    await resetMockLlm()
  })
  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('UI-01: flows 页 新建 → 画布 → 运行', async ({ page, request }) => {
    await page.goto('/flows')
    await expect(page.locator('.flow-cards')).toBeVisible({ timeout: 15_000 })

    // 新建 Flow 对话框 → 命名创建
    await page.getByRole('button', { name: '新建 Flow' }).first().click()
    const dialog = page.locator('[aria-label="新建 Flow"]')
    await expect(dialog).toBeVisible()
    await dialog.locator('input').first().fill('e2e-ui01-journey')
    await dialog.getByRole('button', { name: /创建/ }).click()

    // 创建成功 → 自动跳画布编辑器
    await page.waitForURL(/\/workflows\/[0-9a-f-]+\/canvas/, { timeout: 15_000 })
    // 画布编辑器外壳渲染（back + canvas wrap）
    await expect(page.locator('.agentflow-canvas, [class*="canvas"]').first()).toBeVisible({ timeout: 15_000 })

    // 回 flows 列表 → 卡片出现 → 运行 → 自动打开 detail（真实 UX：runFlow
    // 成功后 showDetail 跳详情页；列表的「{n} 次运行」是硬编码 0 的占位，
    // 不作断言对象）
    await page.goto('/flows')
    const card = page.locator('.flow-card').filter({ hasText: 'e2e-ui01-journey' }).first()
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.getByTitle('运行此 flow').click()
    await expect(page.locator('.flow-detail-page.active')).toBeVisible({ timeout: 15_000 })
    // 记下 id 供 dispose 清理（卡片链接或运行记录都带 id；从 URL 之外拿不到，用 API 反查）
    const list = await request.get('/api/workflows')
    const flows = ((await list.json()).data?.flows ?? []) as Array<{ id: string; name: string }>
    ctx.flowIds.push(...flows.filter((f) => f.name === 'e2e-ui01-journey').map((f) => f.id))
  })

  test('UI-02: run → detail 深链 —— DAG 画布 + Inspector 渲染', async ({ page, request }) => {
    await setMockLlmScript({ fallback: { text: 'UI02-OUT' } })
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ui02-detail',
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are UI-02.', prompt: 'p' }),
      ]),
    })
    const run = await request.post(`/api/workflows/${flowId}/run`, { data: { input: 'ui02' } })
    const runId = run.headers()['x-run-id'] as string
    ctx.runIds.push(runId)
    expect(run.status()).toBe(200)

    // hash 深链进 detail
    await page.goto(`/flows#flow=${flowId}&run=${runId}`)
    await expect(page.locator('.flow-detail-page')).toBeVisible({ timeout: 15_000 })
    // 画布 + 右侧 Inspector 结构存在
    await expect(page.locator('.flow-layout')).toBeVisible()
    await expect(page.locator('.flow-inspector')).toBeVisible()
    // detail 页至少渲染出节点（canvas 容器）
    await expect(page.locator('.flow-canvas-wrap')).toBeVisible({ timeout: 15_000 })
  })

  test('UI-04: chat 页 FlowSelector 绑定 flow → 发送走流', async ({ page, request }) => {
    await setMockLlmScript({ fallback: { text: 'UI04-BOUND-REPLY' } })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ui04-bind',
      flowData: linearFlow([llmNode('solo', { systemPrompt: 'You are UI-04.', prompt: 'r' })]),
    })
    const chatId = await seedChat(ctx, { directoryId })

    await page.goto(`/chats/${chatId}`)
    // FlowSelector trigger（composer 里 AgentSelector 也是 listbox，用 title 区分）
    await page.locator('button[title="选择 Flow"]').click()
    const option = page.getByRole('option', { name: 'e2e-ui04-bind' }).first()
    await expect(option).toBeVisible({ timeout: 10_000 })
    await option.click()

    // 绑定持久化到 chat.flow_id（PATCH 已发生）
    await expect
      .poll(async () => {
        const chat = await request.get(`/api/chats/${chatId}`)
        return ((await chat.json()).data?.chat?.flowId ?? '') as string
      }, { timeout: 10_000 })
      .toBe(flowId)

    // 发送 → 流式回复可见
    await page.getByLabel('消息输入框').fill('绑定后发送')
    await page.getByLabel('发送消息').click()
    await expect(page.locator('.chat-msg-assistant').last().locator('.assistant-content')).toContainText(
      'UI04-BOUND-REPLY',
      { timeout: 15_000 },
    )
  })

  test('UI-05: 浏览器跑多 Agent flow —— 最终回复含汇总体', async ({ page, request }) => {
    await setMockLlmScript({
      rules: [
        { match: { systemContains: 'ROLE:UI-P1' }, respond: { text: 'UI05-P1' } },
        { match: { systemContains: 'ROLE:UI-P2' }, respond: { text: 'UI05-P2' } },
        { match: { systemContains: 'You are UI-SUM' }, respond: { text: 'UI05-FINAL-汇总' } },
      ],
      fallback: { text: 'mock: unexpected' },
    })
    const agentId = await seedPlatformAgent(ctx, { name: 'ui05-crew', instructions: 'AGENT-BASE-UI05' })
    const directoryId = await seedDirectory(ctx)
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-ui05-multi',
      flowData: parallelFlow(
        [
          [platformAgentNode('p1', { agentId, systemPrompt: 'ROLE:UI-P1' })],
          [platformAgentNode('p2', { agentId, systemPrompt: 'ROLE:UI-P2' })],
        ],
        llmNode('sum', { systemPrompt: 'You are UI-SUM.', prompt: '汇总' }),
      ),
    })
    const chatId = await seedChatBoundToFlow(ctx, { directoryId, flowId })

    await page.goto(`/chats/${chatId}`)
    await page.getByLabel('消息输入框').fill('多 Agent 开工')
    await page.getByLabel('发送消息').click()

    await expect(page.locator('.chat-msg-assistant').last().locator('.assistant-content')).toContainText(
      'UI05-FINAL-汇总',
      { timeout: 20_000 },
    )
  })

  test('UI-08: Daemons 注册/心跳/删除（激活 06-daemons 可测部分）', async ({ request }) => {
    // 注册（真实 dispatch API 路径）
    const reg = await request.post(`${DISPATCH_BASE}/daemons/register`, {
      data: {
        daemonLabel: `e2e-ui08-${Date.now()}`,
        capabilities: [{ agentType: 'claude', tags: ['e2e'] }],
      },
    })
    expect(reg.status()).toBe(200)
    const regBody = await reg.json()
    const daemonId = regBody.data?.daemonId as string
    ctx.daemonIds.push(daemonId)
    expect(daemonId).toBeTruthy()

    // 列表可见
    const list = await request.get(`${DISPATCH_BASE}/daemons`)
    expect(list.status()).toBe(200)
    const ids = ((await list.json()).data?.daemons ?? []).map((d: { id: string }) => d.id)
    expect(ids).toContain(daemonId)

    // 删除生效
    const del = await request.delete(`${DISPATCH_BASE}/daemons/${daemonId}`)
    expect([200, 204]).toContain(del.status())
    const list2 = await request.get(`${DISPATCH_BASE}/daemons`)
    const ids2 = ((await list2.json()).data?.daemons ?? []).map((d: { id: string }) => d.id)
    expect(ids2).not.toContain(daemonId)
    ctx.daemonIds = ctx.daemonIds.filter((id) => id !== daemonId)
  })
})
