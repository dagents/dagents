import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  createSeedContext,
  seedDirectory,
  seedChat,
  type SeedContext,
} from './helpers/seed'

/**
 * Sidebar navigation e2e — UC-NAV-01 ~ 07（Workflow-First IA 版，2026-08-29
 * 重写，PRD docs/prd-workflow-first.md 评审 D2）。
 *
 * 新侧栏（app-nav-sidebar.tsx）：工作流 / 运行历史 / 智能体 / 技能 /
 * 守护进程 + 会话历史树。模板不占导航位（2026-08-29 用户裁决：工作流
 * 工具栏「从模板创建」按钮已是入口）；会话历史同样 2026-08-29 用户裁决
 * 恢复「项目目录为第一维度」的树（ChatHistoryTree，与 Chat-First 回滚壳
 * 共用同一实现 —— 搜索/目录重命名删除/每目录新建/会话重命名删除全量回归）。
 *
 *   UC-NAV-01  折叠/展开侧栏（跨刷新持久化）——机制与旧侧栏一致
 *   UC-NAV-02  主导航切换（工作流 → 运行历史 → 智能体）
 *   UC-NAV-03  模板入口 = 工作流工具栏「从模板创建」按钮（不再有 /templates 路由）
 *   UC-NAV-04  当前页 aria-current 标记
 *   UC-NAV-05  项目分组会话树：展开种子目录、点击会话进详情、aria-current
 *   UC-NAV-06  FAB 历史抽屉：搜索并载入会话
 *   UC-NAV-07  设置入口可达
 */

let ctx!: SeedContext
let seededDirId = ''
let seededChatId = ''
const runTag = randomUUID().slice(0, 8)
const dirName = `NAV-Dir-${runTag}`
const chatTitle = `NAV-Chat-${runTag}`

test.describe('Sidebar navigation — Workflow-First IA (UC-NAV-01 ~ 07)', () => {
  test.beforeAll(async () => {
    ctx = await createSeedContext()
    seededDirId = await seedDirectory(ctx, { name: dirName })
    seededChatId = await seedChat(ctx, { directoryId: seededDirId, title: chatTitle })
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  // ── UC-NAV-01: 折叠/展开（持久化）───────────────────────────────────────

  test('UC-NAV-01: collapse and expand the sidebar (persists across reload)', async ({ page }) => {
    const sidebar = page.locator('.chat-layout-sidebar')
    const collapseBtn = page.getByLabel('折叠侧栏', { exact: true })
    await expect(collapseBtn).toBeVisible({ timeout: 10_000 })
    await expect(sidebar).not.toHaveClass(/collapsed/)

    await collapseBtn.click()
    const expandBtn = page.getByLabel('展开侧栏', { exact: true })
    await expect(expandBtn).toBeVisible()
    await expect(sidebar).toHaveClass(/collapsed/)

    await page.reload()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveClass(/collapsed/)

    await expandBtn.click()
    await expect(sidebar).not.toHaveClass(/collapsed/)
  })

  // ── UC-NAV-02: 主导航切换 ────────────────────────────────────────────────

  test('UC-NAV-02: switch primary nav (workflows → run history → agents)', async ({ page }) => {
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 10_000 })

    await page.getByRole('link', { name: '运行历史', exact: true }).click()
    await expect(page).toHaveURL(/\/runs$/, { timeout: 15_000 })

    await page.getByRole('link', { name: '智能体', exact: true }).click()
    await expect(page).toHaveURL(/\/agents$/, { timeout: 15_000 })
  })

  // ── UC-NAV-03: 模板入口 = 工作流工具栏按钮（/templates 路由已删）─────────

  test('UC-NAV-03: toolbar template button opens the gallery (no dedicated nav item)', async ({ page }) => {
    await page.goto('/')
    // 导航里不再有模板项
    await expect(page.locator('.app-nav-item', { hasText: '模板' })).toHaveCount(0)
    // 入口收敛到工具栏「从模板创建」→ 同一画廊对话框
    await page.getByRole('button', { name: '从模板创建' }).click()
    await expect(page.locator('.ftpl-dialog')).toBeVisible({ timeout: 10_000 })
  })

  // ── UC-NAV-04: 当前页 aria-current ───────────────────────────────────────

  test('UC-NAV-04: active nav item carries aria-current=page', async ({ page }) => {
    const agents = page.getByRole('link', { name: '智能体', exact: true })
    await expect(agents).toBeVisible({ timeout: 10_000 })
    await agents.click()
    await expect(page.getByRole('link', { name: '智能体', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('link', { name: '技能', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  // ── UC-NAV-05: 项目分组会话树（ChatHistoryTree）───────────────────────

  test('UC-NAV-05: project-grouped chat tree lists seeded chat and opens its detail', async ({ page }) => {
    await page.goto('/')
    // 2026-08-29 用户裁决：恢复「项目目录为第一维度」的会话树（ChatHistoryTree，
    // 与 Chat-First 壳共用）—— 断言目录分组 + 会话行 + 详情页内 aria-current。
    const group = page.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    await expect(group).toBeVisible({ timeout: 10_000 })
    // 展开种子目录 —— 首目录挂载即自动展开，无条件点击会把它收起
    const header = group.locator('.chat-nav-dir-header')
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
    const item = group.locator('.chat-nav-chat-item').filter({ hasText: chatTitle.slice(0, 12) })
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.click()
    await expect(page).toHaveURL(new RegExp(`/chats/${seededChatId}`), { timeout: 15_000 })
    // 进入详情后树中当前会话带 aria-current=page
    await expect(item).toHaveAttribute('aria-current', 'page')
  })

  // ── UC-NAV-06: FAB 历史抽屉搜索并载入会话 ────────────────────────────────

  test('UC-NAV-06: FAB history drawer searches chats and loads one', async ({ page }) => {
    await page.getByRole('button', { name: '打开聊天' }).click()
    const win = page.locator('.floating-chat-window')
    await expect(win).toBeVisible({ timeout: 10_000 })

    await win.getByRole('button', { name: '历史对话' }).click()
    const search = win.locator('.fab-history-search')
    await expect(search).toBeVisible()
    await search.fill(chatTitle)

    const row = win.locator('.fab-history-item').filter({ hasText: chatTitle })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.click()
    // 抽屉关闭（载入该会话）
    await expect(win.locator('.fab-history-drawer')).toHaveCount(0)
  })

  // ── UC-NAV-07: 设置入口 ──────────────────────────────────────────────────

  test('UC-NAV-07: settings entry navigates to /settings', async ({ page }) => {
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await expect(page).toHaveURL(/\/settings$/, { timeout: 15_000 })
  })
})
