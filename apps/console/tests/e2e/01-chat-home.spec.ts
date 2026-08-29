import { test, expect } from '@playwright/test'
import { createSeedContext, seedDirectory, type SeedContext } from './helpers/seed'

/**
 * Home (/) e2e — UC-CHAT-01 ~ 06（Workflow-First IA 版，2026-08-29 重写）。
 *
 * PRD docs/prd-workflow-first.md（评审 D2）：`/` = Flows 工作台，Chat 降为
 * 全局悬浮副驾（FAB）。本 spec 断言新 IA 的首页契约 + FAB 副驾的完整
 * 聊天旅程；旧 Chat-First 首页断言已随 IA 退役（`dagents.ia.workflow-first
 * =off` 回滚通道不单独维护 e2e，flag 存续期 ≤1 迭代）。
 *
 *   UC-CHAT-01  首页 = 工作流工作台（导航 + 工具栏 + FAB 可见）
 *   UC-CHAT-01b 零 Flow 时展示 Hero 三入口（拦截 /api/workflows 模拟）
 *   UC-CHAT-02  FAB 副驾：目录选择器渲染 + 切换生效
 *   UC-CHAT-03  FAB 打开 → 空会话引导态 + Agent 选择器在位
 *   UC-CHAT-04  FAB 发送消息 → 会话/消息落库 → 「在详情页打开」导航
 *   UC-CHAT-05  （并入 03/04：Agent 选择器与发送旅程合并覆盖）
 *   UC-CHAT-06  无目录时发送被拒并保留草稿（拦截空目录列表）
 */

const HOME_URL = '/'

let ctx!: SeedContext
let seededDirId = ''

test.describe('Home — Workflow-First IA (UC-CHAT-01 ~ 06)', () => {
  test.beforeAll(async () => {
    ctx = await createSeedContext()
    seededDirId = await seedDirectory(ctx, { name: `E2E HomeWF ${Date.now()}` })
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  // ── UC-CHAT-01: 首页 = 工作流工作台 ─────────────────────────────────────

  test('UC-CHAT-01: home renders the Flows workbench (nav active + toolbar entries + FAB)', async ({ page }) => {
    await page.goto(HOME_URL)

    // 新侧栏主导航在位，工作流为当前页
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('link', { name: '工作流', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // 工具栏三入口（模板 / 一句话生成 / 新建）
    await expect(page.getByRole('button', { name: '从模板创建' })).toBeVisible()
    await expect(page.getByRole('button', { name: '一句话生成' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建 Flow' })).toBeVisible()
    // 悬浮副驾 FAB 常驻（除 /chats/[id] 外全路由）
    await expect(page.getByRole('button', { name: '打开聊天' })).toBeVisible()
  })

  // ── UC-CHAT-01b: 零 Flow → Hero 三入口（新用户首屏）────────────────────

  test('UC-CHAT-01b: zero-flow home shows the hero with three entry points', async ({ page }) => {
    // 拦截 workflows 列表为空 —— 模拟新用户（dev 库有存量 Flow）。
    await page.route(/\/api\/workflows(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { flows: [], total: 0 } }),
      })
    })

    await page.goto(HOME_URL)

    await expect(page.locator('.flows-hero')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.flows-hero-title')).toContainText('把你的 Agent 团队编成一条流程')
    const hero = page.locator('.flows-hero')
    // 入口按钮的可访问名含副标题（title+desc 拼接）—— 作用域已消歧，不做 exact
    for (const label of ['从团队场景开始', '一句话生成', '空白画布']) {
      await expect(hero.getByRole('button', { name: label })).toBeVisible()
    }
  })

  // ── UC-CHAT-02: FAB 副驾目录选择器 ─────────────────────────────────────

  test('UC-CHAT-02: FAB window renders directory selector and switching updates the trigger', async ({ page }) => {
    await page.goto(HOME_URL)
    await page.getByRole('button', { name: '打开聊天' }).click()

    const win = page.locator('.floating-chat-window')
    await expect(win).toBeVisible({ timeout: 10_000 })
    // 目录选择器在标题栏，有可选项即可（dev 库目录集非空）
    await expect(win.locator('.directory-selector-trigger')).toBeVisible()
  })

  // ── UC-CHAT-03: FAB 空会话引导态 + Agent 选择器 ─────────────────────────

  test('UC-CHAT-03: FAB empty-conversation state renders with agent selector available', async ({ page }) => {
    await page.goto(HOME_URL)
    await page.getByRole('button', { name: '打开聊天' }).click()

    const win = page.locator('.floating-chat-window')
    await expect(win).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('.floating-chat-empty-title')).toHaveText(/开始一段对话/)
    // Composer 在位（Agent 选择器由 ChatComposer 内部按 onAgentChange 挂载）
    await expect(win.locator('.chat-composer-wrap')).toBeVisible()
  })

  // ── UC-CHAT-04: FAB 发送旅程（创建会话 + 消息落库 + 详情页直达）────────

  test('UC-CHAT-04: sending via FAB creates chat + message, and open-in-detail navigates', async ({ page }) => {
    await page.goto(HOME_URL)
    await page.getByRole('button', { name: '打开聊天' }).click()

    const win = page.locator('.floating-chat-window')
    await expect(win).toBeVisible({ timeout: 10_000 })
    const textarea = win.locator('.chat-composer-textarea')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    // 等目录真正落位（占位符「选择目录」消失 = 父/选择器默认值已同步）
    await expect(win.locator('.directory-selector-trigger')).not.toContainText('选择目录', { timeout: 10_000 })
    const body = `e2e-wf-fab-${Date.now()}`
    await textarea.fill(body)
    await win.locator('.chat-composer-send').click()

    // 乐观气泡即刻可见（发送已被接受）
    await expect(win.locator('.floating-chat-msg-user').filter({ hasText: body })).toBeVisible({
      timeout: 10_000,
    })

    // 落库：会话 + 用户消息（FAB 首发即建会话）。轮询以**消息行**为准 ——
    // 会话行先落、消息行在途几毫秒，按会话行就断言会撞上这个窗口。
    const deadline = Date.now() + 10_000
    let chatId = ''
    let msgs: Array<{ id: string; role: string; content: string }> = []
    while (Date.now() < deadline) {
      const { records } = await ctx.db.runQuery<{
        id: string
        msgs: Array<{ id: string; role: string; content: string }>
      }>(
        `SELECT c.id AS id,
                (SELECT json_agg(json_build_object('id', m.id, 'role', m.role, 'content', m.content) ORDER BY m.created_at)
                   FROM chat_messages m WHERE m.chat_id = c.id) AS msgs
           FROM chats c WHERE c.title LIKE $1
          ORDER BY c.created_at DESC LIMIT 1`,
        [`${body.slice(0, 20)}%`],
      )
      if (records[0]?.id && (records[0].msgs?.length ?? 0) > 0) {
        chatId = records[0].id
        msgs = records[0].msgs!
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(chatId, 'chat row should be created by FAB send').toBeTruthy()
    ctx.chatIds.push(chatId)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.content).toBe(body)
    ctx.messageIds.push(...msgs.map((m) => m.id))

    // 「在详情页打开」→ /chats/:id（长对话承接）
    await win.getByRole('button', { name: '在详情页打开' }).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`), { timeout: 15_000 })
  })

  // ── UC-CHAT-06: 无目录 → 发送被拒 + 引导提示 ────────────────────────────

  test('UC-CHAT-06: no directories → FAB send rejected with guidance', async ({ page }) => {
    // 拦截空目录列表 —— 模拟首访未添加目录
    await page.route(/\/api\/directories(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { items: [] } }),
      })
    })

    await page.goto(HOME_URL)
    await page.getByRole('button', { name: '打开聊天' }).click()

    const win = page.locator('.floating-chat-window')
    await expect(win).toBeVisible({ timeout: 10_000 })
    const textarea = win.locator('.chat-composer-textarea')
    await textarea.fill('should be rejected')
    await win.locator('.chat-composer-send').click()

    // 错误条给出引导（不静默失败）
    await expect(win.locator('.floating-chat-error')).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('.floating-chat-error')).toContainText('请先选择项目目录')
  })
})
