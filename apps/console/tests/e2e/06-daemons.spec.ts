import { test, expect } from '@playwright/test'
import { DISPATCH_BASE } from './helpers/seed'

/**
 * Daemons module e2e — UC-DAE-01 ~ UC-DAE-06.
 *
 * Module status: ❌ 0/6 implemented. The `/daemons` route renders a placeholder
 * ("Daemons 模块开发中") — the three-column layout (queue / timeline / stats)
 * from `design/daemon-execution.html` has not been ported. All six user cases
 * are marked `test.fixme` with the gap from
 * `docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md` §6.
 *
 * When the Daemons three-column page lands (plan Task 7), remove the `.fixme`
 * markers one by one and implement the assertions against the real DOM. The
 * seed helpers + selectors needed are already drafted in the fixme bodies so
 * the activation is mechanical.
 *
 * ## Prerequisites
 *
 * The dev stack must be up (Postgres :15432, Redis :16479, gateway :8080,
 * dispatch :8081) so `/api/dispatch/tasks` and `/api/fleet-stats` resolve.
 * The webServer in playwright.config.ts only owns the Next dev process.
 */

test.describe('Daemons module (UC-DAE-01 ~ 06)', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to /daemons first so a 500/404 on the page itself surfaces
    // clearly rather than as a missing-element timeout.
    await page.goto('/daemons')
  })

  // 2026-08-19 重写：Daemons 页在 2026-08-16 审计后全面改版 —— 任务队列
  // （.daemons-queue/.daemons-task-card，数据源 /api/agents）已被
  // daemon 卡片列表（.daemon-card，数据源 /api/daemons → dispatch）取代；
  // 旧的伪造 stats（.daemons-stats-inline）已移除，计数改为真实
  // "{n} / {total} 个 daemon"。三个用例按当前页面重写。
  test('UC-DAE-01: daemons page renders daemon-card list shell', async ({ page }) => {
    // 页面外壳：状态 scope-tabs + 本机 CLI 区 + 注册入口 + 真实计数
    await expect(page.getByRole('tablist', { name: 'daemon 状态' })).toBeVisible({ timeout: 10_000 })
    // aria-label 同时命中 section 与「重新检测本机 CLI」按钮 —— 用 role=region 精确化
    await expect(page.getByRole('region', { name: '本机 CLI' })).toBeVisible()
    await expect(page.getByRole('button', { name: '注册 Daemon' })).toBeVisible()
    await expect(page.locator('.result-count').first()).toContainText('个 daemon')
  })

  test('UC-DAE-02: registered daemon renders as a card (真实注册路径)', async ({ page, request }) => {
    // 经真实 dispatch API 注册一个 daemon → 页面出现对应卡片
    const reg = await request.post(`${DISPATCH_BASE}/daemons/register`, {
      data: {
        daemonLabel: `e2e-dae-card-${Date.now()}`,
        capabilities: [{ agentType: 'claude', tags: ['e2e'] }],
      },
    })
    expect(reg.ok()).toBe(true)
    const daemonId = ((await reg.json()).data?.daemonId ?? '') as string
    expect(daemonId).toBeTruthy()

    try {
      await page.goto('/daemons')
      const card = page.locator('.daemon-card').filter({ hasText: 'e2e-dae-card' }).first()
      await expect(card).toBeVisible({ timeout: 10_000 })
      // 卡片带心跳与删除操作
      await expect(card.locator('.daemon-card-heartbeat')).toBeVisible()
      await expect(card.locator('.daemon-card-delete')).toBeVisible()
    } finally {
      await request.delete(`${DISPATCH_BASE}/daemons/${daemonId}`).catch(() => {})
    }
  })

  test('UC-DAE-03: daemon count chip reflects the real list', async ({ page }) => {
    // 计数 chip 由真实 daemon 列表计算（filtered / total），加载后格式固定
    await page.goto('/daemons')
    const chip = page.locator('.result-count').first()
    await expect(chip).toBeVisible({ timeout: 10_000 })
    await expect(chip).toHaveText(/\d+ \/ \d+ 个 daemon/)
  })

  test.fixme('UC-DAE-04: filter task queue by status', async ({ page }) => {
    // Gap: 占位页未实现。
    // 期望: 点击 .filter-chip[aria-pressed=true] 切换状态过滤器,
    //       列表按状态刷新。
    await page.locator('.daemons-filters .filter-chip').nth(1).click()
    // Assert queue only shows queued tasks
  })

  test.fixme('UC-DAE-05: select a task to view its timeline', async ({ page }) => {
    // Gap: 占位页未实现。
    // 期望: 点击任务卡,中栏切换到该任务的时间线。
    await page.locator('.daemons-task-card').first().click()
    await expect(page.locator('.daemons-timeline')).toContainText(/run|task/i)
  })

  test.fixme('UC-DAE-06: view real-time log stream', async ({ page }) => {
    // Gap: 占位页未实现。
    // 期望: 中栏底部 log 流,支持 level 过滤、搜索、暂停。
    await expect(page.locator('.daemons-log-stream')).toBeVisible()
  })
})
