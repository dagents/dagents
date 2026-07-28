import { test, expect } from '@playwright/test'
import { createSeedContext, seedDirectory, type SeedContext } from './helpers/seed'

/**
 * Chat Home (/) e2e — UC-CHAT-01 ~ UC-CHAT-06.
 *
 * Module: the Chat-First landing page rendered by `apps/console/src/app/page.tsx`
 * → `ChatHome` (`components/chat-home.tsx`). A centered placeholder (bot avatar +
 * "DAgent Console" title + welcome copy + 2×2 suggestion cards) with a unified
 * `ChatComposer` at the bottom and a `DirectorySelector` in the top bar.
 *
 * UC range & status (from
 * `docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md`, cross-checked
 * against the current component source — the gap-analysis notes for 02/03 were
 * stale, see below):
 *
 *   UC-CHAT-01  查看欢迎屏                    ✅ implemented   — passing test
 *   UC-CHAT-02  顶部切换项目目录              ⚠️ partial→done  — passing test
 *               Gap note said "NO top directory selector UI"; chat-home.tsx now
 *               renders <DirectorySelector> in .chat-home-topbar with a working
 *               trigger + dropdown + onChange→setSelectedDirId. The missing UI
 *               is in place, so this is covered by a passing test (no fixme).
 *   UC-CHAT-03  点击建议卡触发动作            ⚠️ partial→done  — passing test
 *               Gap note said "ALL only call onPick, no /flows /agents nav";
 *               suggestion-cards.tsx now renders 2 cards as <Link href="/flows">
 *               and <Link href="/agents"> (the other 2 still call onPick→send,
 *               whose agent-exec gap is tracked under UC-CHAT-04). The nav gap
 *               is addressed → passing test (no fixme).
 *   UC-CHAT-04  发送消息创建新 chat           ⚠️ partial       — passing + fixme
 *               handleSend creates chat + user message + router.push('/chats/<id>')
 *               (passing test). GAP: it does NOT dispatch a run to the agent
 *               (no POST /api/v1/tasks, chat.last_run_id stays null) → fixme.
 *   UC-CHAT-05  agent selector 选默认 agent   ❌ unimplemented — fixme only
 *               chat-home.tsx renders <ChatComposer onSend=… disabled=… />
 *               WITHOUT onAgentChange; ChatComposer only mounts <AgentSelector>
 *               when `agentSelector && onAgentChange` are both truthy
 *               (chat-composer.tsx:68), so the selector is absent on Chat Home.
 *   UC-CHAT-06  查看错误提示                  ✅ implemented   — passing test
 *               "请先添加项目目录" branch asserted by intercepting
 *               /api/directories with an empty list (no DB mutation of the
 *               dev stack's real directories).
 *
 * Prerequisites: the dagents dev stack must be up — Postgres (:15432),
 * Redis (:16479), gateway (:8080), dispatch (:8081) — so /api/directories and
 * /api/chats resolve. The playwright.config.ts webServer only owns the Next dev
 * process (:3000). beforeAll seeds two directories via @dagents/db runQuery (the
 * same layer the gateway uses); afterAll disposes them. The chat + messages
 * UC-CHAT-04 creates via the UI are registered for cleanup on the fly.
 */

const CHAT_HOME_URL = '/'

// Seeded in beforeAll; ctx is assigned there, hence the definite-assignment
// assertion (strict mode is on via tsconfig.base.json).
let ctx!: SeedContext
let seededDirBName = ''

test.describe('Chat Home (UC-CHAT-01 ~ 06)', () => {
  test.beforeAll(async () => {
    ctx = await createSeedContext()
    // Two seeded directories so the topbar selector has a real switch target
    // distinct from whatever the dev stack already has.
    await seedDirectory(ctx, { name: `E2E ChatHome A ${Date.now()}` })
    seededDirBName = `E2E ChatHome B ${Date.now()}`
    await seedDirectory(ctx, { name: seededDirBName })
  })

  test.afterAll(async () => {
    // `?.` so a beforeAll failure (ctx never assigned) doesn't mask the real
    // error with a dispose-time TypeError.
    await ctx?.dispose()
  })

  // ── UC-CHAT-01: 查看欢迎屏 (✅ implemented) ──────────────────────────────

  test('UC-CHAT-01: welcome screen renders bot avatar, title, copy, and composer', async ({ page }) => {
    await page.goto(CHAT_HOME_URL)

    await expect(page.locator('.chat-home-bot-avatar')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.chat-home-welcome-title')).toHaveText('DAgent 控制台')
    await expect(page.locator('.chat-home-welcome-desc')).toContainText('多 Agent 编排平台')
    // The unified composer is part of the welcome screen (bottom of Chat Home).
    await expect(page.locator('.chat-composer-wrap')).toBeVisible()
    // The suggestion grid is present too (covered in depth by UC-CHAT-03).
    await expect(page.locator('.suggestion-grid')).toBeVisible()
  })

  // ── UC-CHAT-01b: 空状态 CTA (first-time user, no directories) ───────────

  test('UC-CHAT-01b: first-time user with no directories sees empty state CTA', async ({ page }) => {
    // Intercept /api/directories to return empty list — simulates a first-time
    // user with no directories. Same route pattern as UC-CHAT-06.
    await page.route(/\/api\/directories(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { items: [] } }),
      })
    })

    await page.goto(CHAT_HOME_URL)

    // Empty state renders (not the welcome placeholder).
    await expect(page.locator('.chat-home-empty')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.chat-home-empty-title')).toHaveText(/开始前，请先添加一个项目目录/)
    await expect(page.locator('.chat-home-empty-cta')).toBeVisible()
    // The welcome placeholder should NOT be visible.
    await expect(page.locator('.chat-home-placeholder')).not.toBeVisible()
    // Composer send button is disabled when no directories.
    const sendButton = page.locator('.chat-composer-send')
    await expect(sendButton).toBeDisabled()
  })

  // ── UC-CHAT-02: 顶部切换项目目录 (⚠️ partial → addressed in code) ───────

  test('UC-CHAT-02: top directory selector renders, auto-selects a default, and switching updates the trigger', async ({ page }) => {
    // Gap-analysis note: "NO top directory selector UI; default directories[0]
    // selected automatically". chat-home.tsx now renders
    // <DirectorySelector value=… onChange=…> in .chat-home-topbar, and
    // directory-selector.tsx implements a trigger + dropdown + per-option
    // onClick→onChange. So the "missing UI" piece is in place; this test covers
    // the working behavior. The auto-select (directories[0]) half of the note is
    // asserted too (trigger shows a real name, not the '选择目录' placeholder).
    await page.goto(CHAT_HOME_URL)

    const trigger = page.locator('.directory-selector-trigger')
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    // chat-home's useEffect auto-selects directories[0] → the trigger shows a
    // real directory name rather than the '选择目录' placeholder. The selector
    // fetches its own list independently, so wait for both fetches to resolve.
    await expect(trigger).not.toContainText('选择目录', { timeout: 10_000 })

    // Open the dropdown and switch to the seeded directory B.
    await trigger.click()
    const dropdown = page.locator('.directory-selector-dropdown')
    await expect(dropdown).toBeVisible()
    const option = dropdown.locator('.directory-selector-option', { hasText: seededDirBName }).first()
    await expect(option).toBeVisible()
    await option.click()

    // The trigger now reflects the switched-to directory.
    await expect(trigger).toContainText(seededDirBName)
  })

  // ── UC-CHAT-03: 点击建议卡触发动作 (⚠️ partial → nav addressed in code) ─

  test('UC-CHAT-03: 4 suggestion cards render; /flows and /agents cards navigate', async ({ page }) => {
    // Gap-analysis note: "4 suggestion cards exist but ALL only call onPick→
    // handleSend, no /flows /agents navigation". suggestion-cards.tsx now renders
    // 2 cards as <Link href="/flows"> / <Link href="/agents"> (navigate) and 2
    // as <button> calling onPick (send via handleSend — the agent-exec gap for
    // those is tracked under UC-CHAT-04). The navigation gap is addressed.
    await page.goto(CHAT_HOME_URL)

    const grid = page.locator('.suggestion-grid')
    await expect(grid).toBeVisible({ timeout: 10_000 })
    await expect(grid.locator('.suggestion-card')).toHaveCount(4)
    await expect(grid.locator('.suggestion-card-text')).toHaveCount(4)

    // Navigation card → /flows.
    await grid.locator('.suggestion-card', { hasText: '帮我创建一个批量推理的 AgentFlow' }).click()
    await expect(page).toHaveURL(/\/flows/, { timeout: 10_000 })

    // Navigation card → /agents.
    await page.goto(CHAT_HOME_URL)
    await expect(grid).toBeVisible({ timeout: 10_000 })
    await grid.locator('.suggestion-card', { hasText: '查看当前资源看板的 agent 状态' }).click()
    await expect(page).toHaveURL(/\/agents/, { timeout: 10_000 })
  })

  // ── UC-CHAT-04: 发送消息创建新 chat (⚠️ partial) ────────────────────────

  test('UC-CHAT-04: sending a message creates a new chat + user message and navigates to /chats/:id', async ({ page }) => {
    // Working half (per gap note): handleSend creates a chat, creates a user
    // message, and router.push('/chats/<id>'). Assert the navigation + the
    // persisted rows. This does NOT verify agent execution — see the .fixme
    // sibling below.
    await page.goto(CHAT_HOME_URL)

    const textarea = page.locator('.chat-composer-textarea')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    const body = `e2e-uc04-${Date.now()}`
    await textarea.fill(body)
    await page.locator('.chat-composer-send').click()

    await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+/, { timeout: 10_000 })
    const chatId = page.url().match(/\/chats\/([0-9a-f-]+)/)?.[1] ?? ''
    expect(chatId).toBeTruthy()
    // Register the created chat for afterAll cleanup.
    ctx.chatIds.push(chatId)

    const { records: chats } = await ctx.db.runQuery<{ id: string; title: string }>(
      'SELECT id, title FROM chats WHERE id = $1::uuid',
      [chatId],
    )
    expect(chats).toHaveLength(1)

    const { records: msgs } = await ctx.db.runQuery<{ id: string; role: string; content: string }>(
      'SELECT id, role, content FROM chat_messages WHERE chat_id = $1::uuid ORDER BY created_at',
      [chatId],
    )
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.content).toBe(body)
    // Register the messages for cleanup (dispose deletes messages before chats).
    ctx.messageIds.push(...msgs.map((m) => m.id))
  })

  test.fixme('UC-CHAT-04 (gap): sending a message should trigger agent execution', async ({ page }) => {
    // Gap (gap-analysis UC-CHAT-04): handleSend creates chat + user message +
    // router.push, but does NOT dispatch a run to the agent — no
    // POST /api/v1/tasks, no run row, chat.last_run_id stays null. Agent
    // execution is the missing piece. Activate by removing .fixme once the
    // composer's send hand-off dispatches a run (and add chat cleanup).
    await page.goto(CHAT_HOME_URL)
    await page.locator('.chat-composer-textarea').fill('e2e-uc04-run')
    await page.locator('.chat-composer-send').click()
    await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+/, { timeout: 10_000 })
    const chatId = page.url().match(/\/chats\/([0-9a-f-]+)/)?.[1] ?? ''
    const { records } = await ctx.db.runQuery<{ last_run_id: string | null }>(
      'SELECT last_run_id FROM chats WHERE id = $1::uuid',
      [chatId],
    )
    expect(records[0]?.last_run_id).toBeTruthy()
  })

  // ── UC-CHAT-05: agent selector 选默认 agent (❌ unimplemented) ───────────

  test.fixme('UC-CHAT-05: composer agent selector lets you pick the default (auto) agent', async ({ page }) => {
    // Gap (gap-analysis UC-CHAT-05, ❌ unimplemented): chat-home.tsx renders
    //   <ChatComposer onSend={handleSend} disabled={sending} />
    // WITHOUT passing onAgentChange. ChatComposer only mounts <AgentSelector>
    // when `agentSelector && onAgentChange` are both truthy (chat-composer.tsx
    // line 68), so the agent selector is entirely absent on Chat Home — the
    // composer's agent affordance is a static button with no dropdown wired at
    // the chat-home layer. Expected once wired: .agent-selector-trigger visible,
    // click opens .agent-selector-dropdown, first option is 'auto'.
    await page.goto(CHAT_HOME_URL)
    await expect(page.locator('.agent-selector-trigger')).toBeVisible({ timeout: 10_000 })
    await page.locator('.agent-selector-trigger').click()
    await expect(page.locator('.agent-selector-dropdown')).toBeVisible()
    await expect(page.locator('.agent-selector-option').first()).toContainText('auto')
  })

  // ── UC-CHAT-06: 查看错误提示 (✅ implemented) ───────────────────────────

  test('UC-CHAT-06: shows "请先添加项目目录" error when sending with no directory', async ({ page }) => {
    // chat-home's handleSend sets error('请先添加项目目录') when
    // `selectedDirId ?? directories[0]?.id` is null. To exercise this branch
    // without mutating the dev stack's real directories, intercept
    // /api/directories (the endpoint fetchDirectories calls) with an empty list.
    // The RegExp avoids matching /api/directories/:id.
    await page.route(/\/api\/directories(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { items: [] } }),
      })
    })
    await page.goto(CHAT_HOME_URL)

    const textarea = page.locator('.chat-composer-textarea')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('e2e-uc06-no-dir')
    await page.locator('.chat-composer-send').click()

    // The error renders inline below the composer (chat-home.tsx error branch).
    await expect(page.getByText('请先添加项目目录')).toBeVisible({ timeout: 10_000 })
    // And we stay on Chat Home (no chat was created).
    await expect(page.locator('.chat-home-welcome-title')).toBeVisible()
  })
})
