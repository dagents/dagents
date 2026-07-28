import { test, expect } from '@playwright/test'

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

  test('UC-DAE-01: daemons page shows task queue list', async ({ page }) => {
    // Activated: daemons-view renders .daemons-queue with .daemons-task-card
    // items projected from /api/agents.
    await page.route(/\/api\/agents(\?|$)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            agents: [
              {
                id: 'agent-e2e-1',
                name: 'e2e test task',
                kind: 'claude',
                task_id: 'task-e2e-1',
                run_id: 'run-e2e-1',
                task_status: 'queued',
                task_created_at: '2026-07-28T00:00:00.000Z',
                finished_at: null,
              },
            ],
            truncated: false,
          },
        }),
      })
    })
    await page.route(/\/api\/fleet-stats(\?|$)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            windowHours: 1,
            fleet: {
              daemons: { byStatus: {}, total: 0 },
              tasks: { byStatus: {}, total: 0 },
            },
            throughput: { tasks: { completed: 0, failed: 0, total: 0 } },
          },
        }),
      })
    })

    await page.goto('/daemons')

    await expect(page.locator('.daemons-queue')).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator('.daemons-task-card').filter({ hasText: 'e2e test task' }),
    ).toBeVisible()
  })

  test.fixme('UC-DAE-02: view execution timeline (middle column)', async ({ page }) => {
    // Gap: 占位页未实现;原型 .de-timeline / .de-log 完整存在但未移植。
    // 期望: 中栏 .daemons-timeline 显示 active run 的 step progress,
    //       时间线节点(running/done/queued/failed)+ logs。
    await expect(page.locator('.daemons-timeline')).toBeVisible()
  })

  test.fixme('UC-DAE-03: view stats (right column)', async ({ page }) => {
    // Gap: 占位页未实现;/api/fleet-stats/route.ts 存在但未被 daemons 页消费。
    // 期望: 右栏 .daemons-stats 显示 online daemons / active tasks /
    //       queue depth / throughput + 成本仪表盘 + 饼图。
    await expect(page.locator('.daemons-stats')).toBeVisible()
  })

  test.fixme('UC-DAE-04: filter task queue by status', async ({ page }) => {
    // Gap: 占位页未实现。
    // 期望: 点击 .daemons-filter[data-status=queued|running|done|failed],
    //       列表按状态刷新。
    await page.locator('.daemons-filter[data-status="queued"]').click()
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
