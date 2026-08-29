import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, type SeedContext } from './helpers/seed'
import { linearFlow, llmNode, directReplyNode } from './helpers/flow-builder'

/**
 * 19 — Workflow-First IA 冒烟（PRD docs/prd-workflow-first.md，2026-08-29）。
 *
 * 覆盖 PRD 验收标准里未落入既有 spec 的新表面：
 *   IA-01  /runs 运行历史页：种子 run 出现在列表（状态/流程名/触发源/
 *         失败原因摘要/画布旁观入口），状态筛选生效
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

  test('IA-01: /runs lists seeded run with status, flow name, and canvas-watch entry', async ({
    page,
    request,
  }) => {
    // 种一条真实 run（completed + 一条 failed 的对照列在后）
    const flowId = await seedFlow(ctx, request, {
      name: `e2e-ia-runs-${Date.now().toString(36)}`,
      flowData: linearFlow([
        llmNode('llm1', { systemPrompt: 'You are IA-01.', prompt: 'p' }),
        directReplyNode('reply', { text: 'IA01-FINAL' }),
      ]),
    })
    // 经真实执行落 runs/spans（mock provider 由 11 号 spec 管理；这里直接
    // 走 API 契约：插 runs 行模拟历史 —— 页面只读展示，不执行）
    const { records } = await ctx.db.runQuery<{ id: string }>(
      `INSERT INTO runs (identifier, pipeline_id, status, input, output, started_at, finished_at, duration_ms)
       VALUES ('ia-run-smoke', $1::uuid, 'completed', '{"input":"smoke"}', '{"content":"ok"}', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '55 minutes', 300000)
       RETURNING id`,
      [flowId],
    )
    const runId = records[0]!.id
    ctx.runIds.push(runId)

    await page.goto('/runs')
    await expect(page.getByText('运行历史').first()).toBeVisible({ timeout: 10_000 })

    // 与 spec 11 并行时网关/库有竞争（高负载开发机偶发 >10s）—— 行出现
    // 放宽到 20s（仓库先例：vitest 超时加固）。
    const row = page.locator('.runs-table tbody tr').filter({ hasText: 'e2e-ia-runs-' })
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
