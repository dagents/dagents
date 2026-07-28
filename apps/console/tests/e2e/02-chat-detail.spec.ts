import { test, expect } from '@playwright/test'
import {
  createSeedContext,
  seedDirectory,
  seedChat,
  seedMessage,
  seedAgent,
  type SeedContext,
} from './helpers/seed'

/**
 * Chat Detail (/chats/:id) e2e — UC-CHAT-07 ~ UC-CHAT-13.
 *
 * Module: the conversation view rendered by `ChatDetail` (breadcrumb + message
 * stream + composer + right-hand `ChatContextPanel`). Each test navigates to
 * `/chats/{seededId}` and asserts against the real DOM produced by
 * `apps/console/src/components/chat-detail.tsx` and
 * `apps/console/src/components/chat-context-panel.tsx`.
 *
 * ## UC range + status (from the gap analysis,
 *   docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md §Chat Detail)
 *
 *   UC-ID        Name                              Status
 *   UC-CHAT-07   面包屑查看归属与状态                ✅ implemented
 *   UC-CHAT-08   查看消息流(多角色样式)             ⚠️ partial
 *   UC-CHAT-09   发送消息触发 agent 执行(SSE)       ❌ unimplemented
 *   UC-CHAT-10   查看右栏上下文                     ⚠️ partial
 *   UC-CHAT-11   编辑 chat 绑定的 agent/flow        ❌ unimplemented
 *   UC-CHAT-12   查看系统消息特殊样式               ⚠️ partial
 *   UC-CHAT-13   实时查看 chat 状态变化             ⚠️ partial
 *
 * Implementation policy (per task brief):
 *   - ✅ implemented  → real test() with visible-element assertions.
 *   - ⚠️ partial       → real test() for WHAT WORKS today + test.fixme() for the
 *                        missing piece, with a comment explaining the gap.
 *   - ❌ unimplemented → test.fixme() only, with a comment explaining what's
 *                        missing.
 *
 * ## Prerequisites
 *
 * True end-to-end: every `/api/*` call the page makes is proxied through the
 * gateway, so the full dagents dev stack must be up — Postgres (:15432),
 * Redis (:16479), and the gateway (:8080). The `playwright.config.ts`
 * `webServer` only owns the Next dev process (baseURL, :3000 by default —
 * override with `E2E_PORT`). The seed helpers talk to Postgres directly via
 * `@dagents/db`'s `runQuery` (`POSTGRES_URL` defaults to the :15432 dev-stack DSN)
 * and register the seed daemon through the real dispatch API proxied at
 * `/api/v1/dispatch/*`.
 *
 * Setup: `beforeAll` seeds one directory + one agent (via dispatch) + three
 * chats (multi-role messages / empty-for-send / agent-bound-with-history).
 * `afterAll` calls `ctx.dispose()` which drops rows in FK-safe order:
 * messages → chats → directories → agent_daemons → daemons.
 */

test.describe('Chat Detail (UC-CHAT-07 ~ 13)', () => {
  let ctx: SeedContext | undefined
  let directoryId = ''
  let agentId = ''
  /** Chat with one message of each role — covers UC-CHAT-07/08/12/13. */
  let chatWithMessages = ''
  /** Empty chat for the send/SSE scenario — covers UC-CHAT-09. */
  let chatForSend = ''
  /** Agent-bound chat for the context-panel scenarios — covers UC-CHAT-10/11. */
  let chatWithAgent = ''

  test.beforeAll(async ({ request }) => {
    // Use a `const c` for seeding so each helper gets a definitely-assigned
    // SeedContext (avoids any `let` narrowing loss across awaits); `ctx` is
    // stashed only so afterAll can dispose.
    const c = await createSeedContext()
    ctx = c
    directoryId = await seedDirectory(c, { name: 'E2E Chat Detail Dir' })
    const seeded = await seedAgent(c, request, { name: 'e2e-chat-detail-agent' })
    agentId = seeded.agentId

    chatWithMessages = await seedChat(c, {
      directoryId,
      title: 'E2E 多角色消息流',
    })
    // One of each role so UC-CHAT-08/12 can assert the four .chat-msg-* classes.
    await seedMessage(c, { chatId: chatWithMessages, role: 'user', content: '你好,请列出当前目录' })
    await seedMessage(c, { chatId: chatWithMessages, role: 'assistant', content: '当前目录为空。' })
    await seedMessage(c, { chatId: chatWithMessages, role: 'system', content: '路由到 @claude agent' })
    await seedMessage(c, { chatId: chatWithMessages, role: 'tool', content: '{"tool":"ls","result":[]}' })

    // Assistant message carrying usage metadata — covers UC-CHAT usage footer
    // (Phase 4 Task 4.4). Tests the historical message path: the footer must
    // render from persisted metadata on page reload, without any live agent
    // execution. `extractMeta` reads metadata.usage / metadata.durationMs /
    // metadata.cost; the AssistantContent footer formats them as
    // "{N}k tokens · {M}s · ${C}".
    await seedMessage(c, {
      chatId: chatWithMessages,
      role: 'assistant',
      content: '扫描完成,共 3 个文件',
      metadata: {
        runId: 'e2e-run-usage',
        status: 'completed',
        usage: { inputTokens: 1234, outputTokens: 567 },
        durationMs: 2100,
        cost: 0.0123,
      },
    })

    chatForSend = await seedChat(c, { directoryId, title: 'E2E 发送消息', agentId })

    chatWithAgent = await seedChat(c, { directoryId, title: 'E2E 右栏上下文', agentId })
    await seedMessage(c, {
      chatId: chatWithAgent,
      role: 'assistant',
      content: '已完成扫描',
    })
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  // ── UC-CHAT-07: 面包屑查看归属与状态 (✅ implemented) ─────────────────────

  test('UC-CHAT-07: breadcrumb shows directory link, chat title, and status badge', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)

    // Directory segment: a Link to /directories rendering the directory name.
    const dirLink = page.locator('.chat-detail-breadcrumb-dir')
    await expect(dirLink).toBeVisible({ timeout: 10_000 })
    await expect(dirLink).toHaveText(/E2E Chat Detail Dir/)
    await expect(dirLink).toHaveAttribute('href', '/directories')

    // Separator + chat title segment.
    await expect(page.locator('.chat-detail-breadcrumb-sep')).toHaveText('/')
    await expect(page.locator('.chat-detail-breadcrumb-title')).toHaveText('E2E 多角色消息流')

    // Status badge renders with a status-* class and a human label from
    // STATUS_LABEL. A freshly seeded chat is 'idle' → '空闲'.
    const status = page.locator('.chat-detail-breadcrumb-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveText(/空闲|运行中|已完成|失败/)
    await expect(status).toHaveClass(/status-(idle|running|done|failed)/)
  })

  // ── UC-CHAT-08: 查看消息流(多角色样式) (⚠️ partial) ──────────────────────

  test('UC-CHAT-08: four message role classes render with their content', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    // Wait for the stream (not the loading/empty state) before asserting roles.
    await expect(page.locator('.chat-msg-user').first()).toBeVisible({ timeout: 10_000 })

    // Each role renders its own .chat-msg-* class with the seeded content.
    // Assistant messages render via <AssistantContent> → .assistant-content,
    // while user/system/tool render via .chat-msg-content.
    const user = page.locator('.chat-msg-user').first()
    await expect(user.locator('.chat-msg-content')).toHaveText('你好,请列出当前目录')
    const assistant = page.locator('.chat-msg-assistant').first()
    await expect(assistant.locator('.assistant-content')).toBeVisible()
    await expect(assistant).toContainText('当前目录为空。')
    const system = page.locator('.chat-msg-system').first()
    await expect(system.locator('.chat-msg-content')).toHaveText('路由到 @claude agent')
    const tool = page.locator('.chat-msg-tool').first()
    await expect(tool.locator('.chat-msg-content')).toHaveText('{"tool":"ls","result":[]}')
  })

  // Gap (per gap-analysis §Chat Detail UC-CHAT-08): system messages have no
  // special icon/card style, and tool messages don't render metadata. The
  // current JSX does render a .chat-msg-system-icon (zap ⚡) and a .chat-msg-meta
  // for non-system roles incl. tool — but the gap analysis still flags the
  // system card style + tool metadata as partial. Activate (convert to a real
  // test) after re-audit confirms the styling/metadata contract is stable.
  test.fixme('UC-CHAT-08: system message special icon/card style + tool message metadata', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    // System special icon (⚡ zap) inside the centered warn-soft card.
    await expect(page.locator('.chat-msg-system .chat-msg-system-icon')).toBeVisible()
    // Tool message metadata (timestamp / run_id / tool name).
    await expect(page.locator('.chat-msg-tool .chat-msg-meta')).toBeVisible()
  })

  // ── UC-CHAT-09: 发送消息触发 agent 执行 SSE (❌ unimplemented) ────────────

  // Gap: handleSend calls sendChatMessage and the frontend consumes
  // result.events token-by-token, BUT the backend does not actually stream
  // real SSE tokens to the browser — the gateway/dispatch path returns a JSON
  // ack, not a token stream. Until the backend emits real token events, an
  // assistant message with streamed content never materialises. Activate when
  // the SSE token-streaming backend lands.
  test.fixme('UC-CHAT-09: send a message and receive streamed SSE tokens', async ({ page }) => {
    await page.goto(`/chats/${chatForSend}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('列出当前目录')
    await page.keyboard.press('Enter')

    // Optimistic user message appears immediately (handleSend appends it
    // before calling sendChatMessage).
    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    // An assistant message materialises as tokens stream in.
    const assistant = page.locator('.chat-msg-assistant').first()
    await expect(assistant).toBeVisible({ timeout: 15_000 })
    await expect(assistant).not.toBeEmpty()
  })

  // ── UC-CHAT-10: 查看右栏上下文 (⚠️ partial) ──────────────────────────────

  test('UC-CHAT-10: context panel renders 5 sections (directory/agent/flow/stats/runs)', async ({ page }) => {
    await page.goto(`/chats/${chatWithAgent}`)
    await expect(page.locator('.chat-context-panel')).toBeVisible({ timeout: 10_000 })

    // All 5 section titles render (Chinese labels from chat-context-panel.tsx).
    const titles = page.locator('.chat-context-section-title')
    await expect(titles).toHaveCount(5)
    await expect(titles.filter({ hasText: '所属目录' })).toBeVisible()
    await expect(titles.filter({ hasText: '绑定 Agent' })).toBeVisible()
    await expect(titles.filter({ hasText: '绑定 Flow' })).toBeVisible()
    await expect(titles.filter({ hasText: '统计' })).toBeVisible()
    await expect(titles.filter({ hasText: '执行记录' })).toBeVisible()

    // Directory section shows the seeded directory name.
    const dirSection = page.locator('.chat-context-section', { hasText: '所属目录' })
    await expect(dirSection.locator('.chat-context-item')).toHaveText(/E2E Chat Detail Dir/)
  })

  // Gap (per gap-analysis §Chat Detail UC-CHAT-10): "执行记录" only filters
  // messages with runId != null rather than reading a real runs table. The
  // panel now calls fetchChatRuns → /api/chats/:id/runs, but the gap analysis
  // still flags the runs surface as partial. Activate after re-audit confirms
  // the runs endpoint returns real run rows (id/status/createdAt/finishedAt),
  // not message-derived entries.
  test.fixme('UC-CHAT-10: 执行记录 shows real run rows from /api/chats/:id/runs', async ({ page }) => {
    await page.goto(`/chats/${chatWithAgent}`)
    const runsSection = page.locator('.chat-context-section', { hasText: '执行记录' })
    // At least one .chat-context-run with a status pill.
    await expect(runsSection.locator('.chat-context-run').first()).toBeVisible({ timeout: 10_000 })
    await expect(runsSection.locator('.chat-context-run-status').first()).toHaveText(
      /completed|running|failed|queued/i,
    )
  })

  // ── UC-CHAT-11: 编辑 chat 绑定的 agent/flow (❌ unimplemented) ────────────

  // Gap: the gap analysis flags the context panel as read-only and the
  // updateChat schema as not accepting agentId/flowId. The current code does
  // render 编辑 buttons and updateChat's signature accepts agentId/flowId, but
  // per the gap-analysis status this is still unimplemented end-to-end (the
  // PATCH /api/chats/:id persistence + panel refresh is not verified). Activate
  // after re-audit confirms the edit flow persists and reflects the change.
  test.fixme('UC-CHAT-11: edit the chat-bound agent via the context panel', async ({ page }) => {
    await page.goto(`/chats/${chatWithAgent}`)
    const agentSection = page.locator('.chat-context-section', { hasText: '绑定 Agent' })
    await agentSection.getByRole('button', { name: '编辑' }).click()
    // AgentSelector renders; the seeded agent should be selectable. After
    // selection, updateChat persists agentId and the 'chat-updated' event
    // refreshes the panel.
  })

  test.fixme('UC-CHAT-11: edit the chat-bound flow via the context panel', async ({ page }) => {
    await page.goto(`/chats/${chatWithAgent}`)
    const flowSection = page.locator('.chat-context-section', { hasText: '绑定 Flow' })
    await flowSection.getByRole('button', { name: '编辑' }).click()
    const flowInput = page.locator('.chat-context-flow-input')
    await expect(flowInput).toBeVisible()
    await flowInput.fill('flow-e2e-0001')
    await page.locator('.chat-context-flow-save').click()
    // Assert the flow_id is persisted after save.
  })

  // ── UC-CHAT-12: 查看系统消息特殊样式 (⚠️ partial) ────────────────────────

  test('UC-CHAT-12: system message renders with the .chat-msg-system class', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    const systemMsg = page.locator('.chat-msg-system').first()
    await expect(systemMsg).toBeVisible({ timeout: 10_000 })
    await expect(systemMsg.locator('.chat-msg-content')).toHaveText('路由到 @claude agent')
    // The .chat-msg-system class is the special-style hook (centered,
    // warn-soft bg per chat-detail.css).
    await expect(systemMsg).toHaveClass(/chat-msg-system/)
  })

  // Gap (per gap-analysis §Chat Detail UC-CHAT-12): the backend never
  // generates system messages, and the ⚡ icon was flagged as missing. The JSX
  // now renders a .chat-msg-system-icon with a zap icon for the system role,
  // but system messages only appear when seeded manually — the gateway does
  // not emit them on @-command routing today. Activate when the backend emits
  // system messages on routing events (depends on UC-CHAT-09's send path).
  test.fixme('UC-CHAT-12: system message shows the ⚡ zap icon and is backend-generated', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    await expect(page.locator('.chat-msg-system .chat-msg-system-icon')).toBeVisible()
    // And: a real backend-emitted system message (not just a seeded one)
    // appears after an @-command route — covered by UC-CHAT-09's send path,
    // which is itself unimplemented today.
  })

  // ── UC-CHAT-13: 实时查看 chat 状态变化 (⚠️ partial) ──────────────────────

  test('UC-CHAT-13: status badge renders the current persisted status', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    const status = page.locator('.chat-detail-breadcrumb-status')
    await expect(status).toBeVisible({ timeout: 10_000 })
    // Freshly seeded chat is 'idle' → STATUS_LABEL maps to '空闲'.
    await expect(status).toHaveText('空闲')
    // The status is mirrored in the context-panel stats section.
    await expect(page.locator('.chat-context-stat-value.status-idle')).toBeVisible()
  })

  // Gap (per gap-analysis §Chat Detail UC-CHAT-13): there is no mechanism for
  // the frontend to感知 external status changes — no polling, no SSE, no WS.
  // The only refresh path today is the in-page 'chat-updated' CustomEvent,
  // fired by the context panel's own agent/flow edits. A status change driven
  // by the backend (e.g. a daemon completing a run) is not reflected without a
  // manual reload. Activate when a polling/SSE/WS status-refresh mechanism lands.
  test.fixme('UC-CHAT-13: status updates in real-time when the backend changes it', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    // Initial status 空闲.
    await expect(page.locator('.chat-detail-breadcrumb-status')).toHaveText('空闲')
    // Flip the chat status to 'running' out-of-band (e.g. via
    // PATCH /api/chats/:id or a daemon run starting) and assert the badge
    // flips to '运行中' WITHOUT a page reload — requires a polling/SSE/WS
    // refresh mechanism that does not exist today.
  })

  // ── Usage footer (Phase 4 Task 4.4) ─────────────────────────────────────
  //
  // Verifies the `.assistant-usage-footer` renders on a persisted assistant
  // message that carries usage metadata (the historical path users see on
  // page reload). Avoids the live-streaming path (send + wait for chat:done)
  // which would require the `claude` CLI on the gateway — fragile and
  // environment-dependent. `extractMeta` reads metadata.usage /
  // metadata.durationMs / metadata.cost; AssistantContent's UsageFooter
  // formats them as "{N}k tokens · {M}s · ${C}".

  test('UC-CHAT-usage: assistant message with metadata renders usage footer', async ({ page }) => {
    await page.goto(`/chats/${chatWithMessages}`)
    // Wait for messages to load
    await expect(page.locator('.chat-msg-assistant').first()).toBeVisible({ timeout: 10_000 })

    // The seeded assistant message with usage metadata
    const usageAssistant = page.locator('.chat-msg-assistant').filter({ hasText: '扫描完成,共 3 个文件' })
    await expect(usageAssistant).toBeVisible({ timeout: 10_000 })

    // The footer renders inside .assistant-content
    const footer = usageAssistant.locator('.assistant-usage-footer')
    await expect(footer).toBeVisible({ timeout: 5_000 })

    // Footer contains token count (1234 + 567 = 1801 → "1.8k tokens")
    const footerText = await footer.textContent()
    expect(footerText).toMatch(/tokens/)
    // Footer also contains duration (2100ms → "2.1s")
    expect(footerText).toMatch(/2\.1s/)
    // Footer contains cost ($0.0123)
    expect(footerText).toMatch(/\$0\.0123/)
  })
})
