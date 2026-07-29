import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createSeedContext, seedDirectory, seedChat, type SeedContext } from './helpers/seed'

/**
 * Sidebar navigation e2e — UC-NAV-01 ~ UC-NAV-08.
 *
 * ## Module
 *
 * The ChatNavSidebar is the global navigation surface for the Chat-First
 * console: it is rendered by `ChatLayout` (the root layout in `app/layout.tsx`),
 * so it is present on every route under `/` — not just Chat Home. These cases
 * drive it from `/` (Chat Home), which is the canonical entry point.
 *
 * ## UC range & status summary (from gap-analysis §2.3)
 *
 *   UC-NAV-01  折叠/展开 sidebar              ✅ implemented
 *   UC-NAV-02  切换主功能页面                  ✅ implemented
 *   UC-NAV-03  折叠/展开目录分组               ✅ implemented
 *   UC-NAV-04  点击 chat 跳转详情              ✅ implemented
 *   UC-NAV-05  看到 chat 状态点                ⚠️ partial  (dot only; msg-count + status text flagged missing)
 *   UC-NAV-06  通过"+ 添加项目目录"跳转         ✅ implemented
 *   UC-NAV-07  通过"New Chat"跳回 home         ✅ implemented
 *   UC-NAV-08  搜索 chat                       ❌ unimplemented
 *
 * Tally: 6 ✅ / 1 ⚠️ / 1 ❌. ✅ cases are real `test()`s with assertions +
 * interactions; the ⚠️ case has a real test for the implemented part plus a
 * `test.fixme` for the missing part; the ❌ case is `test.fixme` only.
 *
 * ## Prerequisites
 *
 * True end-to-end: the dagents dev stack must be up — Postgres (:15432),
 * Redis (:16479), gateway (:8080) + dispatch (:8081). The sidebar reads
 * directories/chats through the console's `/api/directories` + `/api/chats`
 * proxies, which hit the gateway, which reads the shared Postgres. The
 * `playwright.config.ts` webServer only owns the Next dev process (baseURL,
 * :3000 by default — override with `E2E_PORT`).
 *
 * Auth: on the open dev stack (no SSO) `REQUIRE_LOGIN` is off, so the sidebar
 * renders for everyone after the brief `loading` session-resolve window; the
 * assertions auto-wait on sidebar elements so that window is absorbed.
 *
 * ## Seed
 *
 * `beforeAll` seeds one directory + one chat (default status 'idle',
 * message_count 0) so the directory-grouping + chat-item cases (03/04/05) have
 * deterministic data to locate. Names are tagged with a per-run UUID slice so
 * they never collide with other specs sharing the dev stack. `afterAll` calls
 * `ctx.dispose()` to delete the seeded rows in FK-safe order.
 */

test.describe('Sidebar navigation (UC-NAV-01 ~ 08)', () => {
  let ctx: SeedContext
  let seededDirId: string
  let seededChatId: string

  // Unique per-run tags so the seeded rows are locatable by exact text and
  // never collide with other e2e runs sharing the dev-stack DB.
  const runTag = randomUUID().slice(0, 8)
  const dirName = `NAV-Dir-${runTag}`
  const chatTitle = `NAV-Chat-${runTag}`

  test.beforeAll(async () => {
    ctx = await createSeedContext()
    seededDirId = await seedDirectory(ctx, { name: dirName })
    seededChatId = await seedChat(ctx, { directoryId: seededDirId, title: chatTitle })
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test.beforeEach(async ({ page }) => {
    // Chat Home renders the sidebar (ChatLayout is the root layout).
    await page.goto('/')
  })

  // ── UC-NAV-01: 折叠/展开 sidebar ─────────────────────────────────────────
  test('UC-NAV-01: collapse and expand the sidebar (persists across reload)', async ({
    page,
  }) => {
    const sidebar = page.locator('.chat-layout-sidebar')
    // Expanded initially — toggle shows "折叠侧栏".
    const collapseBtn = page.getByLabel('折叠侧栏', { exact: true })
    await expect(collapseBtn).toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).not.toHaveClass(/collapsed/)

    // Collapse → class flips, toggle label flips to "展开侧栏".
    await collapseBtn.click()
    const expandBtn = page.getByLabel('展开侧栏', { exact: true })
    await expect(expandBtn).toBeVisible()
    await expect(sidebar).toHaveClass(/collapsed/)

    // Persistence: ChatLayout reads localStorage('od:chat-sidebar') on mount,
    // so a reload must keep the collapsed state.
    await page.reload()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveClass(/collapsed/)

    // Expand back → collapsed class drops, label flips back.
    await expandBtn.click()
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await expect(collapseBtn).toBeVisible()
  })

  // ── UC-NAV-02: 切换主功能页面 ────────────────────────────────────────────
  test('UC-NAV-02: switch primary nav page (Chat → Agents)', async ({ page }) => {
    const nav = page.locator('.chat-nav-nav')
    const chatLink = nav.getByRole('link', { name: '对话', exact: true })
    const agentsLink = nav.getByRole('link', { name: 'Agent', exact: true })

    // On home, the Chat nav item is the current page.
    await expect(chatLink).toBeVisible()
    await expect(chatLink).toHaveAttribute('aria-current', 'page')

    // Clicking Agents navigates and flips aria-current.
    await agentsLink.click()
    await expect(page).toHaveURL(/\/agents\/?$/)
    await expect(agentsLink).toHaveAttribute('aria-current', 'page')
    await expect(chatLink).not.toHaveAttribute('aria-current', 'page')
  })

  // ── UC-NAV-03: 折叠/展开目录分组 ─────────────────────────────────────────
  test('UC-NAV-03: collapse and expand a directory group', async ({ page }) => {
    const dirGroup = page.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    const dirHeader = dirGroup.locator('.chat-nav-dir-header')
    const chatItem = dirGroup.locator('.chat-nav-chat-item').filter({ hasText: chatTitle })

    await dirHeader.waitFor({ state: 'visible' })
    // Wait until the directory's chats have loaded (count badge → '1').
    await expect(dirHeader.locator('.chat-nav-dir-count')).toHaveText('1')

    // Ensure the group is expanded: if the chat item isn't visible, click to
    // expand. (Only the first directory auto-expands; the seeded dir may not
    // be first.)
    if (!(await chatItem.isVisible().catch(() => false))) {
      await dirHeader.click()
    }
    await expect(chatItem).toBeVisible()

    // Collapse → chat list disappears.
    await dirHeader.click()
    await expect(chatItem).toBeHidden()

    // Expand again → chat list reappears.
    await dirHeader.click()
    await expect(chatItem).toBeVisible()
  })

  // ── UC-NAV-04: 点击 chat 跳转详情 ────────────────────────────────────────
  test('UC-NAV-04: click a chat to open its detail page', async ({ page }) => {
    const dirGroup = page.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    const dirHeader = dirGroup.locator('.chat-nav-dir-header')
    const chatItem = dirGroup.locator('.chat-nav-chat-item').filter({ hasText: chatTitle })

    await dirHeader.waitFor({ state: 'visible' })
    await expect(dirHeader.locator('.chat-nav-dir-count')).toHaveText('1')
    if (!(await chatItem.isVisible().catch(() => false))) {
      await dirHeader.click()
    }
    await expect(chatItem).toBeVisible()

    // Click the chat → URL becomes /chats/<id>, item becomes aria-selected.
    await chatItem.click()
    await expect(page).toHaveURL(new RegExp(`/chats/${seededChatId}/?$`))
    await expect(chatItem).toHaveAttribute('aria-selected', 'true')
  })

  // ── UC-NAV-05: 看到 chat 状态点 (⚠️ partial) ─────────────────────────────
  test('UC-NAV-05: see the chat status dot', async ({ page }) => {
    const dirGroup = page.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    const dirHeader = dirGroup.locator('.chat-nav-dir-header')
    const chatItem = dirGroup.locator('.chat-nav-chat-item').filter({ hasText: chatTitle })

    await dirHeader.waitFor({ state: 'visible' })
    await expect(dirHeader.locator('.chat-nav-dir-count')).toHaveText('1')
    if (!(await chatItem.isVisible().catch(() => false))) {
      await dirHeader.click()
    }
    await expect(chatItem).toBeVisible()

    // The status dot renders with a class matching chat.status. A freshly
    // seeded chat has status 'idle' (chats.status column default).
    const statusDot = chatItem.locator('.chat-nav-chat-status')
    await expect(statusDot).toBeVisible()
    await expect(statusDot).toHaveClass(/idle/)
  })

  test.fixme('UC-NAV-05: see chat message count + status text', async ({ page }) => {
    // Gap-analysis §2.3: the chat-nav-chat-item renders only the status dot;
    // the "+ 消息数 + 状态" (`.chat-nav-chat-item-count` messageCount +
    // `.chat-nav-chat-item-status` status text) is flagged as not implemented.
    // When confirmed at runtime, drop .fixme and assert both spans against the
    // seeded chat (messageCount '0', status 'idle').
    const dirGroup = page.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    const dirHeader = dirGroup.locator('.chat-nav-dir-header')
    const chatItem = dirGroup.locator('.chat-nav-chat-item').filter({ hasText: chatTitle })
    await dirHeader.waitFor({ state: 'visible' })
    if (!(await chatItem.isVisible().catch(() => false))) {
      await dirHeader.click()
    }
    await expect(chatItem.locator('.chat-nav-chat-item-count')).toHaveText('0')
    await expect(chatItem.locator('.chat-nav-chat-item-status')).toHaveText('idle')
  })

  // ── UC-NAV-06: 通过"+ 添加项目目录"跳转 ──────────────────────────────────
  test('UC-NAV-06: "+ 添加项目目录" link navigates to /directories', async ({ page }) => {
    // With a seeded directory present, the add-dir link renders after the dir
    // list (it also renders in the empty-state branch when no dirs exist).
    const addDirLink = page.getByRole('link', { name: '添加项目目录' })
    await expect(addDirLink).toBeVisible()

    await addDirLink.click()
    await expect(page).toHaveURL(/\/directories\/?$/)
  })

  // ── UC-NAV-07: 通过"New Chat"跳回 home ───────────────────────────────────
  test('UC-NAV-07: "New Chat" button navigates back to home', async ({ page }) => {
    // Start on a non-home route so the home navigation is observable.
    await page.goto('/agents')
    await expect(page).toHaveURL(/\/agents\/?$/)

    const newChatBtn = page.getByRole('button', { name: '新建对话', exact: true })
    await expect(newChatBtn).toBeVisible()

    // handleNewChat → router.push('/').
    await newChatBtn.click()
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
  })

  // ── UC-NAV-08: 搜索 chat (❌ unimplemented) ───────────────────────────────
  test.fixme('UC-NAV-08: search chats by title', async ({ page }) => {
    // Gap-analysis §2.3: the sidebar structure lists "Search", but
    // chat-nav-sidebar was flagged as rendering only the New Chat button — no
    // Search input. When confirmed at runtime, drop .fixme and drive
    // `.chat-nav-search-input`: type a fragment of `chatTitle`, assert the
    // seeded chat remains visible, then type a non-matching string and assert
    // it is hidden.
    const searchInput = page.locator('.chat-nav-search-input')
    await expect(searchInput).toBeVisible()

    const dirGroup = page.locator('.chat-nav-dir-group').filter({ hasText: dirName })
    const dirHeader = dirGroup.locator('.chat-nav-dir-header')
    const chatItem = dirGroup.locator('.chat-nav-chat-item').filter({ hasText: chatTitle })
    await dirHeader.waitFor({ state: 'visible' })
    if (!(await chatItem.isVisible().catch(() => false))) {
      await dirHeader.click()
    }

    await searchInput.fill(runTag)
    await expect(chatItem).toBeVisible()

    await searchInput.fill('zzz-no-such-chat-zzz')
    await expect(chatItem).toBeHidden()
  })
})
