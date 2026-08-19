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
 *   UC-TRG-01    默认通过 agent selector 发消息           fixme（agent 路径走 WS+dispatch，需 daemon/CLI）
 *   UC-TRG-02    @flow <flow-name> <message> 触发 flow   ✅ active（深层契约在 13 号 TR-02）
 *   UC-TRG-03    @daemon <command> 触发 daemon           ✅ active
 *   UC-TRG-04    @agent <agent-name> <message> 临时覆盖  ✅ active
 *   UC-TRG-05    看到 @ 命令提示 + 补全弹窗              ✅ active（2026-08-19 弹窗已实现，激活）
 *   UC-TRG-06    SSE 流式接收 assistant 回复              ✅ 由 13-chat-flow-trigger TR-01/07 覆盖
 *
 * Status summary（2026-08-19 更新）：trigger 面大体落地。执行态的确定性
 * 覆盖（mock LLM、SSE 帧序列、HumanInput 挂起/恢复）迁移至
 * `13-chat-flow-trigger.spec.ts`（docs/e2e-test-plan.md Tier B）；本文件
 * 保留 composer 触发面 + @ 命令 ack 契约。
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
 *     stream route requires `chat.flow_id` and proxies to the workflow engine;
 *     a chat bound only to an agentId (no flow) makes
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
 * gateway, so the full dagents dev stack must be up — Postgres (:15432),
 * Redis (:16479), gateway (:8080), dispatch (:8081), scheduler (for @flow
 * fanout, when wired), and the workflow engine (the current prediction upstream
 * the stream route pipes to). The `playwright.config.ts` `webServer` only owns the
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
  /** Flow id seeded for UC-TRG-02 (@flow daily-summary). Cleaned in afterAll —
   *  SeedContext.dispose() does not delete flows. */
  let flowId = ''
  /** Agent name captured for UC-TRG-04 (@agent override). */
  let agentName = ''

  test.beforeAll(async ({ request }) => {
    // Use a `const c` for seeding so each helper gets a definitely-assigned
    // SeedContext (avoids any `let` narrowing loss across awaits); `ctx` is
    // stashed only so afterAll can dispose.
    const c = await createSeedContext()
    ctx = c
    directoryId = await seedDirectory(c, { name: 'E2E Chat Trigger Dir' })
    const seeded = await seedAgent(c, request, { name: 'e2e-trigger-agent' })
    agentId = seeded.agentId
    agentName = 'e2e-trigger-agent'

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

    // Seed a flow named `daily-summary` for UC-TRG-02 (@flow). routeFlowCommand
    // resolves flows by name from this table; a valid flow_data keeps the async
    // executor path happy. SeedContext.dispose() does not delete flows, so we
    // clean up `flowId` separately in afterAll.
    {
      const { records } = await c.db.runQuery<{ id: string }>(
        `INSERT INTO flows (name, description, flow_data, status)
         VALUES ('daily-summary', 'e2e test flow',
                 '{"nodes":[{"id":"start","position":{"x":0,"y":0},"type":"start","data":{}}],"edges":[]}',
                 'published')
         RETURNING id`,
      )
      flowId = records[0]!.id
    }
  })

  test.afterAll(async () => {
    // SeedContext.dispose() does not delete flows — clean up the seeded
    // `daily-summary` flow here, before disposing the rest of the context.
    if (flowId) {
      await ctx?.db.runQuery(`DELETE FROM flows WHERE id = $1::uuid`, [flowId])
    }
    await ctx?.dispose()
  })

  // ── UC-TRG-01: 默认通过 agent selector 发消息(SSE) (❌ unimplemented) ──────

  // Gap（2026-08-19 更新）：agent 绑定的 chat 走 WS + dispatch/inline 路径
  // （chat-detail 的 handleWsFrame 消费 chat:message/chat:done 帧），不经过
  // SSE —— 确定性 e2e 需要 daemon 或本机 CLI，不适合作自动化。flow 绑定
  // 的 chat 的完整 SSE 流式链路已由 13-chat-flow-trigger TR-01/07 覆盖。
  // 激活条件：agent 路径具备确定性 mock 手段（如 dispatch 任务 mock）。
  test.fixme('UC-TRG-01: default send via agent selector streams an assistant reply', async ({ page, request }) => {
    // --- Browser: the composer + agent selector are the trigger surface ---
    await page.goto(`/chats/${chatForSend}`)
    const textarea = page.getByLabel('消息输入框')
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

  // ── UC-TRG-02: @flow <flow-name> <message> 触发 flow ──────────────────────

  // Activated: routeFlowCommand now resolves the flow by name, binds it to
  // the chat, and fire-and-forgets the workflow engine. The ack payload
  // carries runId + flowId (verified against chat-execute.ts source).
  test('UC-TRG-02: @flow triggers a named flow and acks in-chat', async ({ page, request }) => {
    // --- Browser: typing @flow renders a system ack in the message stream ---
    await page.goto(`/chats/${chatForCommands}`)
    const textarea = page.getByLabel('消息输入框')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('@flow daily-summary 生成今日报告')
    await page.keyboard.press('Enter')

    // User message is persisted.
    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    // System ack appears (routeCommand writes role='system'). Use .last()
    // because chatForCommands is shared across UC-TRG-02/03/04 and system
    // messages accumulate; .first() would match the earliest ack from a
    // prior test.
    const ack = page.locator('.chat-msg-system').last()
    await expect(ack).toBeVisible({ timeout: 10_000 })
    await expect(ack.locator('.chat-msg-content')).toHaveText(/Flow triggered: daily-summary/)

    // --- API contract: POST @flow returns mode='json' with runId + flowId ---
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
    expect(typeof body.data.payload?.runId).toBe('string')
    expect(typeof body.data.payload?.flowId).toBe('string')
  })

  // ── UC-TRG-03: @daemon <command> 触发 daemon ──────────────────────────────

  // Activated: routeDaemonCommand now POSTs to dispatch /api/v1/dispatch/invoke
  // and returns runId + taskId in the ack payload (verified against
  // chat-execute.ts source). chatForCommands has agent_id bound in beforeAll.
  test('UC-TRG-03: @daemon invokes a daemon and acks in-chat', async ({ page, request }) => {
    await page.goto(`/chats/${chatForCommands}`)
    const textarea = page.getByLabel('消息输入框')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('@daemon run daily scan')
    await page.keyboard.press('Enter')

    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    // Use .last() — chatForCommands is shared and system acks accumulate.
    const ack = page.locator('.chat-msg-system').last()
    await expect(ack).toBeVisible({ timeout: 10_000 })
    await expect(ack.locator('.chat-msg-content')).toHaveText(/Daemon invoked: run daily scan/)

    // --- API contract: POST @daemon returns mode='json' with runId + taskId ---
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
    expect(typeof body.data.payload?.runId).toBe('string')
    expect(typeof body.data.payload?.taskId).toBe('string')
  })

  // ── UC-TRG-04: @agent <agent-name> <message> 临时覆盖 agent ───────────────

  // Activated: routeAgentCommand resolves the agent by name from agent_daemons
  // and fire-and-forgets executeInline with the override agent. The ack payload
  // carries runId (verified against chat-execute.ts source). `agentName` is
  // captured in beforeAll so the test reads the same value that was seeded.
  test('UC-TRG-04: @agent overrides the routing agent and acks in-chat', async ({ page, request }) => {
    await page.goto(`/chats/${chatForCommands}`)
    const textarea = page.getByLabel('消息输入框')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill(`@agent ${agentName} hello from override`)
    await page.keyboard.press('Enter')

    await expect(page.locator('.chat-msg-user').first()).toBeVisible()
    // Use .last() — chatForCommands is shared and system acks accumulate.
    const ack = page.locator('.chat-msg-system').last()
    await expect(ack).toBeVisible({ timeout: 10_000 })
    await expect(ack.locator('.chat-msg-content')).toHaveText(new RegExp(`Routed to agent: ${agentName}`))

    // --- API contract: POST @agent returns mode='json' with runId ---
    const res = await request.post(`/api/chats/${chatForCommands}/messages`, {
      data: { content: `@agent ${agentName} hello from override`, role: 'user' },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.mode).toBe('json')
    expect(body.data.payload?.ack).toMatch(new RegExp(`Routed to agent: ${agentName}`))
    expect(body.data.payload?.command?.kind).toBe('agent')
    expect(body.data.payload?.command?.target).toBe(agentName)
    expect(typeof body.data.payload?.runId).toBe('string')
  })

  // ── UC-TRG-05: 看到 @ 命令提示 (⚠️ partial) ───────────────────────────────

  // What works today: the composer renders a static hint span naming the @
  // trigger. This is a real assertion against the shipped DOM.
  test('UC-TRG-05: composer shows the static @ command hint text', async ({ page }) => {
    await page.goto(`/chats/${chatForHint}`)
    const hint = page.locator('.chat-composer-hint')
    await expect(hint).toBeVisible({ timeout: 10_000 })
    // Exact copy from chat-composer.tsx — covers send / newline / @ trigger.
    // 2026-08-19：hint 文案已改为「@ 命令」（@ 补全菜单由 cmd-menu 提供）
    await expect(hint).toHaveText('⏎ 发送 · ⇧⏎ 换行 · @ 命令')
  })

  // Activated（2026-08-19）：chat-composer 现已实现 @ 补全菜单（.cmd-menu，
  // role=listbox「命令选择」），含 @agent/@flow/@workflow/@daemon 四项。
  test('UC-TRG-05: typing @ opens a command completion popup', async ({ page }) => {
    await page.goto(`/chats/${chatForHint}`)
    const textarea = page.getByLabel('消息输入框')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('@')

    const popup = page.locator('.cmd-menu')
    await expect(popup).toBeVisible()
    for (const cmd of ['@agent', '@flow', '@workflow', '@daemon']) {
      await expect(popup.getByText(cmd, { exact: true })).toBeVisible()
    }
  })

  // ── UC-TRG-06: SSE 流式接收 assistant 回复 ────────────────────────────────

  // 覆盖迁移（2026-08-19）：flow 绑定 chat 的 SSE token 流式（浏览器渲染 +
  // 落库一致 + 帧序列断言）已由 13-chat-flow-trigger.spec.ts 的
  // TR-01/TR-07 以 Mock LLM 确定性覆盖（docs/e2e-test-plan.md Tier B），
  // 此处不再保留 fixme 副本。
})
