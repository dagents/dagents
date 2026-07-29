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
 * (TAB_A11Y); the active affordance is `aria-selected` + `aria-current`.
 *
 * ## UC range & status summary (from gap-analysis)
 *
 *   UC-SET-01  管理 API Key        ✅ implemented  (live CRUD: /api/tokens/* → gateway → new-api)
 *   UC-SET-02  配置默认模型        ✅ implemented  (read-only shell, shape-aligned to design)
 *   UC-SET-03  配置预算配额        ✅ implemented  (read-only shell)
 *   UC-SET-04  配置通知            ✅ implemented  (tab exposed, read-only shell)
 *   UC-SET-05  管理账户团队        ✅ implemented  (tab exposed, read-only shell)
 *   UC-SET-06  危险区操作          ✅ implemented  (tab exposed, read-only shell)
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
    for (const shortName of ['LLM Provider', '默认模型', '预算配额', '通知', '账户团队', '危险区']) {
      await expect(tablist.getByRole('tab', { name: shortName, exact: true })).toBeVisible()
    }

    // LLM Provider is the default active tab — aria-selected + aria-current both
    // mark it active (settings-view.tsx:116-117).
    const keysTab = tablist.getByRole('tab', { name: 'LLM Provider', exact: true })
    await expect(keysTab).toHaveAttribute('aria-selected', 'true')
    await expect(keysTab).toHaveAttribute('aria-current', 'true')

    // The keys <section> (aria-label="LLM Provider 管理") renders the live CRUD
    // surface — toolbar (search + status filter chips + new-token CTA) and
    // the token table. Thead always renders; tbody swaps between
    // loading / error / empty / rows.
    const section = page.getByRole('region', { name: 'LLM Provider 管理' })
    await expect(section).toBeVisible()
    await expect(section.getByText('LLM Provider 管理', { exact: true })).toBeVisible()

    // new-api gateway card.
    await expect(section.getByText('new-api 网关', { exact: true })).toBeVisible()

    // Toolbar: search input + three status filter chips + new-token button.
    await expect(section.getByLabel('搜索令牌')).toBeVisible()
    for (const chip of ['启用', '禁用', '已过期']) {
      await expect(section.getByRole('button', { name: chip, exact: true })).toBeVisible()
    }
    await expect(section.getByRole('button', { name: '+ 新建令牌' })).toBeVisible()

    // Token table headers (always rendered regardless of load state).
    for (const header of ['名称', '分组', '额度', '过期', '操作']) {
      await expect(section.locator('th').filter({ hasText: header })).toBeVisible()
    }
  })

  // ── UC-SET-02: 配置默认模型 (✅ implemented, read-only shell) ─────────────
  test('UC-SET-02: 默认模型 tab renders role-assignment + fallback chain', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const modelsTab = tablist.getByRole('tab', { name: '默认模型', exact: true })

    // Clicking the tab flips aria-selected / aria-current and swaps the
    // visible section.
    await modelsTab.click()
    await expect(modelsTab).toHaveAttribute('aria-selected', 'true')
    await expect(modelsTab).toHaveAttribute('aria-current', 'true')

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

  // ── UC-SET-03: 配置预算配额 (✅ implemented, read-only shell) ─────────────
  test('UC-SET-03: 预算配额 tab renders platform budget + circuit-breaker rules', async ({
    page,
  }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const quotaTab = tablist.getByRole('tab', { name: '预算配额', exact: true })

    await quotaTab.click()
    await expect(quotaTab).toHaveAttribute('aria-selected', 'true')
    await expect(quotaTab).toHaveAttribute('aria-current', 'true')

    const section = page.getByRole('region', { name: '预算与配额' })
    await expect(section).toBeVisible()
    await expect(section.getByText('预算与配额', { exact: true })).toBeVisible()

    // 全平台预算 card — month budget bar + 熔断阈值 marker.
    await expect(section.getByText('全平台预算', { exact: true })).toBeVisible()
    await expect(section.getByText('月预算', { exact: true })).toBeVisible()
    await expect(section.getByText(/熔断阈值/)).toBeVisible()

    // 熔断规则 card — toggle-row primitives (disabled, read-only).
    await expect(section.getByText('熔断规则', { exact: true })).toBeVisible()
    await expect(section.getByText('单 run 成本超 $5 暂停', { exact: true })).toBeVisible()
  })

  // ── UC-SET-04: 配置通知 (✅ implemented, read-only shell) ─────────────────
  test('UC-SET-04: 通知 tab renders event toggles + channel list', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const notifyTab = tablist.getByRole('tab', { name: '通知', exact: true })

    await notifyTab.click()
    await expect(notifyTab).toHaveAttribute('aria-selected', 'true')
    await expect(notifyTab).toHaveAttribute('aria-current', 'true')

    const section = page.getByRole('region', { name: '通知' })
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

  // ── UC-SET-05: 管理账户团队 (✅ implemented, read-only shell) ─────────────
  test('UC-SET-05: 账户团队 tab renders personal KV + team member list', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const accountTab = tablist.getByRole('tab', { name: '账户团队', exact: true })

    await accountTab.click()
    await expect(accountTab).toHaveAttribute('aria-selected', 'true')
    await expect(accountTab).toHaveAttribute('aria-current', 'true')

    const section = page.getByRole('region', { name: '账户与团队' })
    await expect(section).toBeVisible()
    await expect(section.getByText('账户与团队', { exact: true })).toBeVisible()

    // 个人 card — kv primitive (姓名 / 邮箱 / 角色 / SSO / 默认 workspace).
    await expect(section.getByText('个人', { exact: true })).toBeVisible()
    const personal = section.locator('.kv')
    await expect(personal).toBeVisible()
    await expect(personal.getByText('姓名', { exact: true })).toBeVisible()
    await expect(personal.getByText('邮箱', { exact: true })).toBeVisible()

    // 团队 card — member rows (model-row primitive) + 邀请 button (disabled).
    await expect(section.getByText('团队 · 38 成员', { exact: true })).toBeVisible()
    await expect(section.getByText('饶哲', { exact: true })).toBeVisible()
    await expect(section.getByText('林敏', { exact: true })).toBeVisible()
    await expect(section.getByRole('button', { name: '邀请', exact: true })).toBeDisabled()
  })

  // ── UC-SET-06: 危险区操作 (✅ implemented, read-only shell) ───────────────
  test('UC-SET-06: 危险区 tab renders suspend / rotate / delete actions', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: '设置分组' })
    const dangerTab = tablist.getByRole('tab', { name: '危险区', exact: true })

    await dangerTab.click()
    await expect(dangerTab).toHaveAttribute('aria-selected', 'true')
    await expect(dangerTab).toHaveAttribute('aria-current', 'true')

    const section = page.getByRole('region', { name: '危险区' })
    await expect(section).toBeVisible()
    await expect(section.locator('.danger-zone')).toBeVisible()

    // Three danger rows (toggle-row primitive) with their CTAs. All buttons
    // are disabled today (design-aligned placeholder; wiring deferred).
    await expect(section.getByText('暂停所有运行中的 run', { exact: true })).toBeVisible()
    await expect(section.getByText('轮换全部令牌', { exact: true })).toBeVisible()
    await expect(section.getByText('删除 workspace 及全部数据', { exact: true })).toBeVisible()

    await expect(section.getByRole('button', { name: '暂停全部', exact: true })).toBeDisabled()
    await expect(section.getByRole('button', { name: '轮换全部', exact: true })).toBeDisabled()
    await expect(section.getByRole('button', { name: '删除', exact: true })).toBeDisabled()
  })
})
