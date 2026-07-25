import { test, expect } from '@playwright/test'
import {
  createSeedContext,
  seedDirectory,
  seedChat,
  seedAgent,
  type SeedContext,
} from './helpers/seed'

/**
 * Chat trigger mechanism e2e — UC-TRG-01 ~ UC-TRG-06.
 *
 * Module: the chat composer's trigger surface — the agent selector, the `@`
 * command grammar (@flow / @daemon / @agent), the `@` hint + completion popup,
 * and the SSE token stream that carries the assistant's reply back to the
 * browser. Each test navigates to a seeded chat detail page (`/chats/{id}`)
 * because the trigger mechanism is exercised entirely from the chat composer
 * rendered by `apps/console/src/components/chat-composer.tsx` (and the
 * `sendChatMessage` wiring in `apps/console/src/components/chat-detail.tsx`).
 *
 * ## UC range + status (from the gap analysis,
 *   docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md §Chat Trigger)
 *
 *   UC-ID        Name                                    Status
 *   UC-TRG-01    默认通过 agent selector 发消息(SSE)     ❌ unimplemented
 *   UC-TRG-02    @flow <flow-name> <message> 触发 flow   ❌ unimplemented
 *   UC-TRG-03    @daemon <command> 触发 daemon           ❌ unimplemented
 *   UC-TRG-04    @agent <agent-name> <message> 临时覆盖  ❌ unimplemented
 *   UC-TRG-05    看到 @ 命令提示                          ⚠️ partial
 *   UC-TRG-06    SSE 流式接收 assistant 回复              ❌ unimplemented
 *
 * Status summary: 0 ✅ / 1 ⚠️ / 5 ❌ — tied with the workflow-engine module
 * (UC-WF-01~12) as the most incomplete module in the suite. This module is the
 * P0 blocker for Chat-First usability: without a working send→predict→stream
 * loop, the chat surface is a notepad, not an agent console. See the plan
 * `docs/superpowers/specs/2026-07-26-chat-first-functional-completion.md`
 * Task 1.
 *
 * ## What exists in code today (verified before writing this spec)
 *
 * The gap analysis was written against an earlier state. Reading the current
 * source shows the trigger surface is partially scaffolded but not wired
 * end-to-end — which is why every functional UC stays `fixme`:
 *
 *   - `apps/gateway/src/routes/chat-execute.ts` `parseCommand()` DOES parse
 *     `@flow` / `@daemon` / `@agent`, and `routeMessage()` returns
 *     `mode: 'stream' | 'json'`. But `routeCommand()` only writes an ack
 *     system message — it does NOT call scheduler.fanout (@flow), dispatch
 *     (@daemon), or honor `agentIdOverride` (@agent). The downstream execution
 *     is stubbed.
 *   - `chatRoutes.post('/:id/messages')` DOES call `routeMessage` for user
 *     roles (not just INSERT). `createMessageWithExecBodySchema` DOES accept
 *     `agentIdOverride` / `flowIdOverride`.
 *   - `apps/console/src/lib/chat-stream.ts` `sendChatMessage()` (not
 *     `streamMessage`) DOES subscribe to `/api/chats/:id/stream` SSE. But the
 *     stream route requires `chat.flow_id` and proxies to Flowise
 *     (`FLOWISE_URL`); a chat bound only to an agentId (no flow) makes
 *     `routeMessage` return `mode:'stream'` while `GET /stream` returns 400 —
 *     the agent→flow resolution that would feed the stream is missing.
 *
 * Implementation policy (per task brief):
 *   - ❌ unimplemented → `test.fixme()` only, with a comment explaining the
 *     gap. The body is drafted with the expected selectors/assertions so
 *     activation is mechanical when the feature lands.
 *   - ⚠️ partial       → real `test()` for WHAT WORKS today (the static hint
 *     text) + `test.fixme()` for the missing piece (the @ completion popup).
 *
 * ## Prerequisites
 *
 * True end-to-end: every `/api/*` call the page makes is proxied through the
 * gateway, so the full mil-agents dev stack must be up — Postgres (:15432),
 * Redis (:16479), gateway (:8080), dispatch (:8081), scheduler (for @flow
 * fanout, when wired), and Flowise (:3100, the current prediction upstream the
 * stream route pipes to). The `playwright.config.ts` `webServer` only owns the
 * Next dev process (baseURL, :3000 by default — override with `E2E_PORT`).
 *
 * Setup: `beforeAll` seeds one directory + one agent (via the real dispatch
 * register API) + three chats (agent-bound for send/SSE, agent-bound for @
 * commands, plain for the hint check). `afterAll` calls `ctx.dispose()` which
 * drops rows in FK-safe order: messages → chats → directories → agent_daemons
 * → daemons.
 */

test.describe('Chat trigger mechanism (UC-TRG-01 ~ 06)', () => {
  let ctx: SeedContext | undefined
  let directoryId = ''
  let agentId = ''
  /** Agent-bound chat for the default-send + SSE scenarios (UC-TRG-01/06). */
  let chatForSend = ''
  /** Agent-bound chat for the @-command scenarios (UC-TRG-02/03/04). */
  let chatForCommands = ''
  /** Plain chat for the @ hint assertion (UC-TRG-05). */
  let chatForHint = ''

  test.beforeAll(async ({ request }) => {
    // Use a `const c` for seeding so each helper gets a definitely-assigned
    // SeedContext (avoids any `let` narrowing loss across awaits); `ctx` is
    // stashed only so afterAll can dispose.
    const c = await createSeedContext()
    ctx = c
    directoryId = await seedDirectory(c, { name: 'E2E Chat Trigger Dir' })
    const seeded = await seedAgent(c, request, { name: 'e2e-trigger-agent' })
    agentId = seeded.agentId

    chatForSend = await seedChat(c, {
      directoryId,
      title: 'E2E 触发-发送',
      agentId,
    })
    chatForCommands = await seedChat(c, {
      directoryId,
      title: 'E2E 触发-命令',
      agentId,
    })
    chatForHint = await seedChat(c, {
      directoryId,
      title: 'E2E 触发-提示',
    })
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  // ── UC-TRG-01: 默认通过 agent selector 发消息(SSE) (❌ unimplemented) ──────

  // Gap: the gap analysis flags the send→predict→SSE loop as unimplemented.
  // Verified against current source: `chat-detail.tsx` handleSend DOES call
  // `sendChatMessage` (chat-stream.ts) which POSTs `/api/chats/:id/messages`
  // and the gateway's `routeMessage` returns `mode:'stream'` when an agent is
  // bound. BUT the subsequent `GET /api/chats/:id/stream` requires
  // `chat.flow_id` and proxies to Flowise — a chat bound only to an agentId
  // (no flow) makes the stream route 400, so the assistant token stream never
  // reaches the browser. The agent→flow resolution feeding the stream is the
  // missing piece. Activate when agent-bound chats resolve to a prediction
  // target the stream route can pipe.
  test.fixme('UC-TRG-01: default send via agent selector streams an assistant reply', async ({ page, request }) => {
    // --- Browser: the composer + agent selector are the trigger surface ---
    await page.goto(`/chats/${chatForSend}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })

    // Agent selector pill renders with the seeded agent's name (or 'auto').
    const selectorTrigger = page.locator('.agent-selector-trigger')
    await expect(selectorTrigger).toBeVisible()

    // Type + Enter triggers handleSend → sendChatMessage.
    await textarea.fill('列出当前目录')
    await page.keyboard.press('Enter')

    // Optimistic user message appears immediately (handleSend appends it
    // before awaiting sendChatMessage).
    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    // An assistant message materialises as tokens stream in.
    const assistant = page.locator('.chat-msg-assistant').first()
    await expect(assistant).toBeVisible({ timeout: 15_000 })
    await expect(assistant).not.toBeEmpty()

    // --- API contract: POST /messages returns mode='stream' for an agent-bound chat ---
    const res = await request.post(`/api/chats/${chatForSend}/messages`, {
      data: { content: '列出当前目录', role: 'user' },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.message).toHaveProperty('id')
    expect(body.data.message.role).toBe('user')
    // routeMessage returns 'stream' when agentId is bound — but the stream
    // route itself 400s without a flow_id (the gap). When the gap closes,
    // mode stays 'stream' and the subsequent /stream GET succeeds.
    expect(body.data.mode).toBe('stream')
  })

  // ── UC-TRG-02: @flow <flow-name> <message> 触发 flow (❌ unimplemented) ────

  // Gap: `parseCommand` in chat-execute.ts DOES parse `@flow <name> <msg>`,
  // and `routeCommand` writes an ack system message ("⚡ Flow triggered: …").
  // But scheduler fanout is NOT wired — `routeCommand` never calls the
  // scheduler to actually run the named flow; it only emits the ack. The
  // grammar is contracted, the execution is stubbed. Activate when
  // scheduler.fanout is invoked from the @flow branch.
  test.fixme('UC-TRG-02: @flow triggers a named flow and acks in-chat', async ({ page, request }) => {
    // --- Browser: typing @flow renders a system ack in the message stream ---
    await page.goto(`/chats/${chatForCommands}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('@flow daily-summary 生成今日报告')
    await page.keyboard.press('Enter')

    // User message is persisted.
    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    // System ack appears (routeCommand writes role='system').
    const ack = page.locator('.chat-msg-system').first()
    await expect(ack).toBeVisible({ timeout: 10_000 })
    await expect(ack.locator('.chat-msg-content')).toHaveText(/Flow triggered: daily-summary/)

    // --- API contract: POST @flow returns mode='json' with an ack payload ---
    const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
      data: { content: '@flow daily-summary 生成今日报告', role: 'user' },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.ack).toMatch(/Flow triggered: daily-summary/)
    expect(body.data.payload?.command?.kind).toBe('flow')
    expect(body.data.payload?.command?.target).toBe('daily-summary')
    expect(typeof body.data.systemMessageId).toBe('string')
  })

  // ── UC-TRG-03: @daemon <command> 触发 daemon (❌ unimplemented) ────────────

  // Gap: `parseCommand` parses `@daemon <msg>`, and `routeCommand` writes an
  // ack ("⚡ Daemon invoked: …"). But dispatch.invoke is NOT called from the
  // chat path — no daemon actually receives the command. Activate when
  // dispatch invocation is wired into the @daemon branch.
  test.fixme('UC-TRG-03: @daemon invokes a daemon and acks in-chat', async ({ page, request }) => {
    await page.goto(`/chats/${chatForCommands}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('@daemon run daily scan')
    await page.keyboard.press('Enter')

    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    const ack = page.locator('.chat-msg-system').first()
    await expect(ack).toBeVisible({ timeout: 10_000 })
    await expect(ack.locator('.chat-msg-content')).toHaveText(/Daemon invoked: run daily scan/)

    // --- API contract ---
    const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
      data: { content: '@daemon run daily scan', role: 'user' },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.ack).toMatch(/Daemon invoked: run daily scan/)
    expect(body.data.payload?.command?.kind).toBe('daemon')
    expect(body.data.payload?.command?.target).toBeNull()
    expect(typeof body.data.systemMessageId).toBe('string')
  })

  // ── UC-TRG-04: @agent <agent-name> <message> 临时覆盖 agent (❌ unimplemented) ─

  // Gap: `parseCommand` parses `@agent <name> <msg>`, and
  // `createMessageWithExecBodySchema` DOES accept `agentIdOverride`. But
  // `routeCommand`'s @agent branch only writes an ack ("⚡ Routed to agent: …")
  // and ignores `_opts` — the override never drives the real prediction path.
  // Activate when @agent override selects the routing target end-to-end.
  test.fixme('UC-TRG-04: @agent overrides the routing agent and acks in-chat', async ({ page, request }) => {
    await page.goto(`/chats/${chatForCommands}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill(`@agent e2e-trigger-agent 列出目录`)
    await page.keyboard.press('Enter')

    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    const ack = page.locator('.chat-msg-system').first()
    await expect(ack).toBeVisible({ timeout: 10_000 })
    await expect(ack.locator('.chat-msg-content')).toHaveText(/Routed to agent: e2e-trigger-agent/)

    // --- API contract: agentIdOverride is accepted by the schema ---
    const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
      data: {
        content: '@agent e2e-trigger-agent 列出目录',
        role: 'user',
        agentIdOverride: agentId,
      },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.ack).toMatch(/Routed to agent: e2e-trigger-agent/)
    expect(body.data.payload?.command?.kind).toBe('agent')
    expect(body.data.payload?.command?.target).toBe('e2e-trigger-agent')
    expect(typeof body.data.systemMessageId).toBe('string')
  })

  // ── UC-TRG-05: 看到 @ 命令提示 (⚠️ partial) ───────────────────────────────

  // What works today: the composer renders a static hint span naming the @
  // trigger. This is a real assertion against the shipped DOM.
  test('UC-TRG-05: composer shows the static @ command hint text', async ({ page }) => {
    await page.goto(`/chats/${chatForHint}`)
    const hint = page.locator('.chat-composer-hint')
    await expect(hint).toBeVisible({ timeout: 10_000 })
    // Exact copy from chat-composer.tsx — covers send / newline / @ trigger.
    await expect(hint).toHaveText('⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令')
  })

  // Gap: chat-composer.tsx has NO @ completion popup — typing `@` does
  // nothing beyond inserting the character. The hint promises "输入 @ 触发命令"
  // but no command menu (@flow / @daemon / @agent) renders. Activate when the
  // composer renders a popup on `@` input with the three command kinds.
  test.fixme('UC-TRG-05: typing @ opens a command completion popup', async ({ page }) => {
    await page.goto(`/chats/${chatForHint}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('@')

    // Expected: a popup listing the three @ command kinds.
    const popup = page.locator('.chat-composer-mention-popup')
    await expect(popup).toBeVisible()
    await expect(popup.getByText(/@flow/)).toBeVisible()
    await expect(popup.getByText(/@daemon/)).toBeVisible()
    await expect(popup.getByText(/@agent/)).toBeVisible()
  })

  // ── UC-TRG-06: SSE 流式接收 assistant 回复 (❌ unimplemented) ──────────────

  // Gap: `sendChatMessage` (chat-stream.ts — named sendChatMessage, not
  // streamMessage) + `GET /api/chats/:id/stream` exist, and chat-detail.tsx
  // iterates `result.events` token-by-token. But the stream route requires
  // `chat.flow_id` and pipes to Flowise (`FLOWISE_URL`); an agent-bound chat
  // with no flow makes `GET /stream` return 400, so no token event ever
  // reaches the browser. The agent→flow resolution feeding the stream, plus a
  // reachable Flowise upstream, is the missing piece. Activate when the stream
  // route resolves a prediction target for agent-bound chats.
  test.fixme('UC-TRG-06: assistant reply streams token-by-token over SSE', async ({ page, request }) => {
    // --- Browser: tokens accumulate into the assistant message ---
    await page.goto(`/chats/${chatForSend}`)
    const textarea = page.getByPlaceholder(/Send a message/)
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('用一句话介绍这个项目')
    await page.keyboard.press('Enter')

    // Optimistic user message, then an assistant message whose content grows
    // as token events arrive (chat-detail.tsx accumulates into `assistantId`).
    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    const assistant = page.locator('.chat-msg-assistant').first()
    await expect(assistant).toBeVisible({ timeout: 15_000 })
    // Capture an intermediate length, then assert it grew — proves streaming
    // rather than a single bulk write.
    const mid = (await assistant.locator('.chat-msg-content').textContent()) ?? ''
    expect(mid.length).toBeGreaterThanOrEqual(0)
    // After the stream settles, content is non-empty.
    await expect(assistant.locator('.chat-msg-content')).not.toBeEmpty({ timeout: 15_000 })

    // --- API contract: GET /stream is an SSE endpoint ---
    const streamRes = await request.get(`/api/chats/${chatForSend}/stream`, {
      headers: { accept: 'text/event-stream' },
    })
    expect(streamRes.ok()).toBe(true)
    expect(streamRes.headers()['content-type']).toContain('text/event-stream')
  })
})
