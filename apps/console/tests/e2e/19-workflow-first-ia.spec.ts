import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'
import { linearFlow, llmNode, directReplyNode } from './helpers/flow-builder'

/**
 * 19 — Workflow-First IA 冒烟（PRD docs/prd-workflow-first.md，2026-08-29）。
 *
 * 覆盖 PRD 验收标准里未落入既有 spec 的新表面：
 *   IA-01  flow 卡片展开区的运行历史（2026-08-30 用户裁决：/runs 页已
 *         删，历史进卡片 FlowRunsPanel）：种子 run 出现（状态/触发源/
 *         画布旁观入口）
 *   IA-02  画布页 FAB 避让 minimap（D5）：fab 带 canvas 偏移类
 *   IA-03  画布顶栏「一句话生成」入口存在（F7 三入口之一，行为由
 *         WF 系列与 17 号覆盖，这里只钉入口可达）
 *   IA-04  IA 回滚通道：`dagents.ia.workflow-first=off` 时 `/` 回到
 *         聊天主页（P3 观察期的回滚保证）
 */

let ctx!: SeedContext

test.describe('Workflow-First IA smoke (IA-01 ~ IA-04)', () => {
  test.beforeAll(async () => {
    ctx = await createSeedContext()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('IA-01: flow card expand shows per-flow run history (runs panel)', async ({
    page,
    request,
  }) => {
    const flowName = `e2e-ia-runs-${Date.now().toString(36)}`
    const flowId = await seedFlow(ctx, request, {
      name: flowName,
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are IA-01.', prompt: 'p' }),
        directReplyNode('reply', { text: 'IA01-FINAL' }),
      ]),
    })
    // 插 runs 行模拟历史 —— 面板只读展示，不执行
    const { records } = await ctx.db.runQuery<{ id: string }>(
      `INSERT INTO runs (identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms)
       VALUES ('ia-run-smoke', $1::uuid, 'completed', '{"input":"smoke"}', '{"content":"ok"}', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '55 minutes', 300000)
       RETURNING id`,
      [flowId],
    )
    const runId = records[0]!.id
    ctx.runIds.push(runId)

    await page.goto('/')
    // 展开种子 flow 卡片（data-toggle 是卡片头的展开开关）
    const card = page.locator('.flow-card').filter({ hasText: flowName })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.locator('[data-toggle]').first().click()

    // 展开区出现该 run 的紧凑行（与其它 spec 并行时放宽等待）
    const row = card.locator('.flow-runs-row').filter({ hasText: 'smoke' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('已完成')
    // 画布旁观入口（?run= 直达）
    await expect(row.getByRole('link', { name: '画布旁观' })).toHaveAttribute(
      'href',
      new RegExp(`/workflows/${flowId}/canvas\\?run=${runId}`),
    )
  })

  test('IA-02: FAB on canvas page carries the minimap-avoidance offset (D5)', async ({
    page,
    request,
  }) => {
    const flowId = await seedFlow(ctx, request, {
      name: `e2e-ia-fab-${Date.now().toString(36)}`,
      flowData: linearFlow([directReplyNode('reply', { text: 'IA02' })]),
    })
    await page.goto(`/workflows/${flowId}/canvas`)
    // 画布加载较重，FAB 出现即断言避让类在位
    const fab = page.getByRole('button', { name: '打开聊天' })
    await expect(fab).toBeVisible({ timeout: 30_000 })
    await expect(fab).toHaveClass(/fab-canvas-offset/)
  })

  test('IA-03: Flows toolbar exposes the one-sentence generation entry (F7)', async ({ page }) => {
    await page.goto('/')
    const btn = page.getByRole('button', { name: '一句话生成', exact: true }).first()
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()
    // 对话框打开（生成服务本身由 11/17 号与 mock 钉住，这里只钉入口）
    await expect(page.getByRole('dialog', { name: '一句话生成工作流' })).toBeVisible()
  })

  test('IA-04: rollback channel — flag off restores the Chat-First home', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('dagents.ia.workflow-first', 'off')
    })
    await page.goto('/')
    // 旧 IA：聊天主页的 composer + 侧栏会话树（ChatNavSidebar）
    await expect(page.locator('.chat-composer-wrap')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.chat-nav-sidebar')).toBeVisible()
    await expect(page.locator('.app-nav-root, [aria-label="主导航"]')).toHaveCount(0)
  })
})
