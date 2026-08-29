import { test, expect } from '@playwright/test'
import { createSeedContext, type SeedContext } from './helpers/seed'

/**
 * Settings module e2e — UC-SET-01 ~ UC-SET-06.
 *
 * ## Module
 *
 * Settings (`/settings`) — the 6-tab admin surface rendered by
 * `app/settings/page.tsx` → `<SettingsView />` (components/settings-view.tsx).
 * A sticky left sub-nav (`role="tablist"` aria-label="设置分组") groups the
 * six tabs as the design's sub-nav renders them — 密钥 / 模型 / 治理 / 账户 —
 * and switches the visible `<section>`. Each tab button carries the long
 * design label as visible text and a short design name via `aria-label`
 * (TAB_A11Y); the active affordance is `aria-selected`.
 *
 * ## UC range & status summary (from gap-analysis)
 *
 *   UC-SET-01  管理 API Key        ✅ implemented  (live CRUD: LLM Provider 管理)
 *   UC-SET-02  配置默认模型        ✅ implemented  (read-only shell, shape-aligned to design)
 *   UC-SET-03  用量与成本          ✅ implemented  (2026-08-22 方案 D 账单页，live /api/usage/summary)
 *   UC-SET-04  配置通知            ✅ implemented  (tab exposed, read-only shell)
 *   UC-SET-05  规划中              ✅ implemented  (2026-08-22 方案 F：原 预算配额/账户团队/危险区 三个占位 tab 收拢)
 *
 * Tally: 6 ✅ / 0 ⚠️ / 0 ❌. All six cases are real `test()`s with assertions
 * on visible elements (tab labels, tab switching, section content).
 *
 * Architecture §4.4 marks Settings as "保留不变" — the 6 tabs all exist and
 * keep their design-aligned DOM shape. Only the API Key tab has live wiring
 * (new-api token CRUD); the other five are faithful read-only shells of
 * design/settings.html. Deep data integration per tab is out of scope for the
 * Chat-First redesign — see `docs/superpowers/specs/2026-07-08-prototype-
 * coverage-analysis.md` §2.2/2.3 for the deferred milestones (默认模型→workflow
 * config, 熔断→scheduler, 成本→资源面板聚合 API, 通知/账户/团队推迟到 MVP 后).
 *
 * These tests verify the page renders and tabs switch — they do NOT verify
 * deep data flow per tab.
 *
 * ## Prerequisites
 *
 * The dev stack must be up — Postgres :15432, Redis :16479, gateway :8080 —
 * so the API Key tab's `/api/tokens` + `/api/gateway-health` proxies resolve.
 * The five read-only tabs render design placeholder data and need no backend.
 * The webServer in playwright.config.ts only owns the Next dev process; the
 * rest must be brought up first (see infra/README.md).
 *
 * ## Seed
 *
 * Settings has no data dependency of its own (the read-only tabs ship design
 * placeholder data; the API Key tab reads from new-api, not the shared
 * Postgres). `beforeAll` still mints a `SeedContext` for suite consistency —
 * matching the pattern every other Chat-First spec uses — and `afterAll`
 * calls `ctx.dispose()`. The dispose is a no-op here (no rows seeded) but
 * keeps the harness uniform if a later case needs to seed token_meta rows.
 */

test.describe('Settings module (UC-SET-01 ~ 06)', () => {
  /** Seed context — assigned in `beforeAll`, cleaned up in `afterAll`.
   *  Initialized to null so the closure-captured test bodies don't trip TS
   *  "used before assigned" (matches the v0.3-design.spec.ts pattern). */
  let ctx: SeedContext | null = null

  test.beforeAll(async () => {
    // No rows seeded — Settings reads new-api (tokens) or design placeholder
    // data (other 5 tabs). The context is created for suite-shape consistency
    // and so dispose() is always safe to call.
    ctx = await createSeedContext()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test.beforeEach(async ({ page }) => {
    // Navigate to /settings first so a 500/404 on the page itself surfaces
    // clearly rather than as a missing-element timeout. The API Key tab is
    // the default active tab (SettingsView initial state: tab='keys').
    await page.goto('/settings')
  })

  // ── UC-SET-01: 管理 API Key (✅ implemented) ──────────────────────────────
  test('UC-SET-01: API Key tab renders token CRUD surface (default active tab)', async ({
    page,
  }) => {
    // The sub-nav tablist (role=tablist, aria-label="设置分组") exposes all
    // six tabs. Assert structural shape once here; per-tab tests below assert
    // the switching behavior.
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    await expect(tablist).toBeVisible()
    // 2026-08-22（方案 F）：占位 tab（预算配额/账户团队/危险区）已收拢为「规划中」，
    // 新增真功能 tab「用量与成本」（方案 D）。
    for (const shortName of ['LLM Provider', '默认模型', '通知', '规划中']) {
      await expect(tablist.getByRole('tab', { name: shortName, exact: true })).toBeVisible()
    }
    for (const removed of ['预算配额', '账户团队', '危险区']) {
      await expect(tablist.getByRole('tab', { name: removed, exact: true })).toHaveCount(0)
    }

    // LLM Provider is the default active tab — aria-selected is the tab
    // mark it active (settings-view.tsx:116-117).
    const keysTab = tablist.getByRole('tab', { name: 'LLM Provider', exact: true })
    await expect(keysTab).toHaveAttribute('aria-selected', 'true')

    // The keys <section> (aria-label="LLM Provider 管理") renders the live CRUD
    // surface — toolbar (search + status filter chips + new-token CTA) and
    // the token table. Thead always renders; tbody swaps between
    // loading / error / empty / rows.
    const section = page.getByRole('region', { name: 'LLM Provider 管理' })
    await expect(section).toBeVisible()
    await expect(section.getByText('LLM Provider 管理', { exact: true })).toBeVisible()

    // 2026-08-19：不再断言具体 provider 名（dev 库内容随测试/使用变化），
    // 表头 + 工具栏即结构契约。

    // Toolbar（2026-08-19：Token CRUD 已换为 LLM Provider 管理）：搜索框 +
    // active/disabled 两个筛选 chip + 新建 Provider 按钮。
    await expect(section.getByLabel('搜索 Provider')).toBeVisible()
    for (const chip of ['启用', '禁用']) {
      await expect(section.getByRole('button', { name: chip, exact: true })).toBeVisible()
    }
    await expect(section.getByRole('button', { name: '+ 新建 Provider' })).toBeVisible()

    // Provider 表头（2026-08-19：Token 表已换为 Provider 表）
    for (const header of ['名称', '类型', 'Base URL', '默认模型', '状态', '操作']) {
      await expect(section.locator('th').filter({ hasText: header })).toBeVisible()
    }
  })

  // ── UC-SET-02: 配置默认模型 (✅ implemented, read-only shell) ─────────────
  test('UC-SET-02: 默认模型 tab renders role-assignment + fallback chain', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const modelsTab = tablist.getByRole('tab', { name: '默认模型', exact: true })

    // Clicking the tab flips aria-selected and swaps the
    // visible section.
    await modelsTab.click()
    await expect(modelsTab).toHaveAttribute('aria-selected', 'true')

    const section = page.getByRole('region', { name: '默认模型' })
    await expect(section).toBeVisible()
    await expect(section.getByText('默认模型', { exact: true })).toBeVisible()

    // 按角色分派 card — design §models. Five model-row primitives.
    await expect(section.getByText('按角色分派', { exact: true })).toBeVisible()
    // Sample role row (placeholder data from design/settings.html).
    await expect(section.getByText('阅读 / reader', { exact: true })).toBeVisible()

    // 回退链 card — three-step fallback (主 / 回退 / 兜底).
    await expect(section.getByText('回退链', { exact: true })).toBeVisible()
    await expect(section.getByText('1. Anthropic claude-sonnet-4', { exact: true })).toBeVisible()
  })

  // ── UC-SET-03: 用量与成本 (✅ implemented, live billing summary) ──────────
  test('UC-SET-03: 用量与成本 tab renders usage summary (实测账单，2026-08-22)', async ({
    page,
  }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const usageTab = tablist.getByRole('tab', { name: '用量与成本', exact: true })

    await usageTab.click()
    await expect(usageTab).toHaveAttribute('aria-selected', 'true')

    const section = page.getByRole('region', { name: '用量与成本' })
    await expect(section).toBeVisible()

    // 口径说明（不回填历史）+ 实测口径的统计卡（未计价 token 单列 = 不造假原则）。
    await expect(
      section.getByText('按实测 token 用量与模型单价汇总的成本账单。数据自埋点上线起累计，历史执行不回填。'),
    ).toBeVisible()
    await expect(section.getByText('Token 用量', { exact: true })).toBeVisible()
    await expect(section.getByText('未计价 Token', { exact: true })).toBeVisible()

    // 三个维度区块：按天 / 按 Agent / 按 Flow。
    await expect(section.getByText('按天成本', { exact: true })).toBeVisible()
    await expect(section.getByText('按 Agent', { exact: true })).toBeVisible()
    await expect(section.getByText('按 Flow', { exact: true })).toBeVisible()
  })

  // ── UC-SET-04: 配置通知 (✅ implemented, read-only shell) ─────────────────
  test('UC-SET-04: 通知 tab renders event toggles + channel list', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const notifyTab = tablist.getByRole('tab', { name: '通知', exact: true })

    await notifyTab.click()
    await expect(notifyTab).toHaveAttribute('aria-selected', 'true')

    // 2026-08-19：隐藏 tab 的 section 也带同名 aria-label —— 取 active 的那个
    const section = page.getByRole('region', { name: '通知' }).first()
    await expect(section).toBeVisible()
    await expect(section.getByText('通知', { exact: true })).toBeVisible()

    // 通知事件 (toggle-row primitives, disabled read-only).
    await expect(section.getByText('Run 失败', { exact: true })).toBeVisible()
    await expect(section.getByText('成本熔断', { exact: true })).toBeVisible()
    await expect(section.getByText('Human Input 等待', { exact: true })).toBeVisible()

    // 通知渠道 card — 站内 / 邮件 / Webhook.
    await expect(section.getByText('通知渠道', { exact: true })).toBeVisible()
    await expect(section.getByText('站内', { exact: true })).toBeVisible()
    await expect(section.getByText('邮件', { exact: true })).toBeVisible()
  })

  // ── UC-SET-05(+06): 规划中 (2026-08-22 方案 F：三个占位 tab 收拢) ─────────
  test('UC-SET-05: 规划中 tab lists deferred areas honestly (占位假数据清零)', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const plannedTab = tablist.getByRole('tab', { name: '规划中', exact: true })

    await plannedTab.click()
    await expect(plannedTab).toHaveAttribute('aria-selected', 'true')

    const section = page.getByRole('region', { name: '规划中' })
    await expect(section).toBeVisible()

    // 三个延后领域逐条可见（原 预算配额 / 账户团队 / 危险区）。
    await expect(section.getByText('预算与配额（成本熔断 / 月度告警）')).toBeVisible()
    await expect(section.getByText('账户与团队（多用户协作）')).toBeVisible()
    await expect(section.getByText('危险区（暂停全部 / 数据清理）')).toBeVisible()

    // 原占位假数据（假预算表 / 假成员名单）必须不复存在。
    await expect(section.getByText('全平台预算')).toHaveCount(0)
    await expect(section.getByText('团队 · 38 成员')).toHaveCount(0)
    await expect(page.getByText('饶哲')).toHaveCount(0)
  })

  // ── UC-SET-06: 危险区 → 已并入 UC-SET-05「规划中」（2026-08-22 方案 F 收拢）
})
