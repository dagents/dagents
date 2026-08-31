import { test, expect } from '@playwright/test'
import { createSeedContext, seedFlow, resetMockLlm, type SeedContext } from './helpers/seed'
import { linearFlow, directReplyNode } from './helpers/flow-builder'

/**
 * 21 — 画布直链可用性（PRD FR-01 / 决议 D1）。
 *
 * 背景：画布页复用 ftpl-canvas-column / ftpl-canvas-body 布局类，而这两条
 * 规则此前只被 flow-template-gallery.tsx 导入 —— 从列表页客户端导航进来
 * 时样式表恰好在页面上，一切正常；**直接打开 / 刷新 / 外部旁观链接**时
 * 样式缺失，`.ftpl-canvas-column` 计算为 display:block，`.react-flow` 高度
 * 塌缩为 0（DOM 全在、视觉全无，改窗口尺寸不可恢复）。修复 = 画布 page
 * 显式 import '@/styles/flow-templates.css'。
 *
 * 本用例的关键在导航方式：Playwright 的 page fixture 每个 test 都是全新
 * context —— `page.goto(canvasUrl)` 是真正的「直链首载」，没有客户端导航
 * 预载 CSS 的侥幸。断言走视觉尺寸而非 DOM 存在性（评审 D8：存在性断言
 * 正是两个 P0 全绿漏网的盲区）。
 */

test.describe('画布直链可用性（FR-01）', () => {
  let ctx: SeedContext

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    await resetMockLlm()
  })
  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('CV-01: 直接 goto 画布 URL —— 布局类生效、画布可见高度 > 400px', async ({ page, request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-cv01-direct-url',
      flowData: linearFlow([directReplyNode('reply', { text: 'cv01' })]),
    })

    // 全新 context + 直接 URL —— 复刻「刷新 / 书签 / 外部旁观链接」路径
    await page.goto(`/workflows/${flowId}/canvas`)
    await page.waitForSelector('.react-flow', { timeout: 20_000 })
    // dev 冷编译首帧可能未水合稳定，expect 轮询兜一层
    await expect
      .poll(async () => page.locator('.ftpl-canvas-column').evaluate((el) => getComputedStyle(el).display), { timeout: 15_000 })
      .toBe('flex')

    const height = await page.locator('.react-flow').evaluate((el) => Math.round(el.getBoundingClientRect().height))
    expect(height).toBeGreaterThan(400)
  })

  test('CV-02: 直链旁观 ?run= —— 同样不塌缩', async ({ page, request }) => {
    const flowId = await seedFlow(ctx, request, {
      name: 'e2e-cv02-spectator',
      flowData: linearFlow([directReplyNode('reply', { text: 'cv02' })]),
    })

    await page.goto(`/workflows/${flowId}/canvas?run=00000000-0000-0000-0000-000000000000`)
    await page.waitForSelector('.react-flow', { timeout: 20_000 })
    await expect
      .poll(async () => page.locator('.react-flow').evaluate((el) => Math.round(el.getBoundingClientRect().height)), { timeout: 15_000 })
      .toBeGreaterThan(400)
  })
})
