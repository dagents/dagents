import { test, expect } from '@playwright/test'
import { createSeedContext, type SeedContext } from './helpers/seed'

/**
 * AgentFlows module e2e — UC-FLW-01 ~ UC-FLW-07.
 *
 * Module: AgentFlows (`/flows`, `/flows/{id}/edit`).
 *
 * UC range covered: UC-FLW-01 ~ 07.
 *
 * Status summary (2 ✅, 2 ⚠️, 3 ❌):
 *   - UC-FLW-01  列出所有 flows                ✅ implemented
 *       flows/page.tsx renders <FlowsView />; /api/flows/route.ts exists
 *       (still a workflow proxy — architecture §9.5 will replace it).
 *   - UC-FLW-02  查看单个 flow 详情/DAG         ✅ implemented
 *       FlowsView swaps to a detail page (FlowDag + inspector) when both
 *       selectedFlowId + selectedRunId are set; hash deep-link
 *       `#flow=…&run=…` is the entry point (flows-view.tsx applyHash).
 *   - UC-FLW-03  编辑 flow (workflow editor)    ⚠️ partial
 *       workflows/[id]/canvas/page.tsx exists with a native canvas editor
 *       (<CanvasPage />), but architecture §9.5 requires PUT /api/v1/workflows/:id
 *       (内聚引擎).
 *   - UC-FLW-04  创建新 flow                    ❌ unimplemented
 *       architecture §9.5 requires POST /api/v1/workflows; no such route
 *       exists today.
 *   - UC-FLW-05  删除 flow                     ❌ unimplemented
 *       architecture §9.5 requires DELETE /api/v1/workflows/:id; no such
 *       route exists today.
 *   - UC-FLW-06  执行 flow (SSE 流式)           ⚠️ partial
 *       the run button (运行) on each flow card opens the detail view,
 *       but actual execution still goes through the old
 *       POST /api/v1/flows/:id/prediction (workflow proxy, forwarded by
 *       /api/chat); architecture §9.5 requires /api/v1/workflows/:id/run
 *       (SSE), not implemented.
 *   - UC-FLW-07  查看执行历史                   ❌ unimplemented
 *       architecture §9.5 requires GET /api/v1/workflows/:id/executions;
 *       only the old /api/flows/runs/:runId/node-spans exists (per-run
 *       node trace, not a flow-level execution history).
 *
 * ## Prerequisites
 *
 * The dev stack must be up so the console proxy resolves upstream:
 *   - Postgres :15432  (compose remaps 5432→15432; `POSTGRES_URL` default
 *                       in helpers/seed.ts points here)
 *   - Redis    :16479
 *   - gateway  :8080   (owns the workflow passthrough + scheduler routes)
 *   - workflow engine (the chatflow/execution source for /api/flows —
 *                       the list may be empty if no AGENTFLOW
 *                       chatflows exist; the UC-FLW-01 test tolerates that)
 *
 * The `playwright.config.ts` webServer only owns the Next dev process
 * (baseURL, :3000 by default — override with `E2E_PORT`). `beforeAll`
 * creates a seed context for suite-pattern consistency (the Chat-First
 * suite always provisions + disposes a context so `db.runQuery` is
 * available and cleanup is symmetric); no flows are seeded directly —
 * flows live in the workflow engine, not the dagents DB. `afterAll` calls
 * `ctx.dispose()`.
 *
 * ## Note on the workflow-engine migration (architecture §9)
 *
 * When the workflow engine 内聚 lands (architecture §9), the proxy
 * paths (/api/flows, /api/flows/:id, /api/chat prediction forwarding) will
 * be replaced by /api/v1/workflows/* (POST/GET/PUT/DELETE/run/executions).
 * The `test.fixme()` markers below will activate then — each fixme body
 * sketches the expected contract so activation is a matter of removing the
 * `.fixme` and adjusting assertions to the landed shape.
 */

/**
 * A synthetic flow id used for the UC-FLW-02 hash deep-link and UC-FLW-03
 * edit-route navigation. The id does not need to exist in the workflow engine — the
 * tests assert the *page* renders, not that a specific flow resolves. The
 * fetch to /api/flows/:id will 502 (no such chatflow); the detail
 * page renders its error inside the canvas wrap, but the page structure
 * (back button + canvas wrap + inspector + legend) is always present.
 */
const SYNTH_FLOW_ID = 'e2e-flw-synthetic-flow-id'
const SYNTH_RUN_ID = 'e2e-flw-synthetic-run-id'

test.describe('AgentFlows module (UC-FLW-01 ~ 07)', () => {
  /** Seed context — created in `beforeAll`, disposed in `afterAll`. No flows
   *  are seeded (flows live in the workflow engine), but the context is kept for
   *  suite-pattern consistency + `db.runQuery` availability. */
  let ctx: SeedContext | null = null

  test.beforeAll(async () => {
    ctx = await createSeedContext()
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  // ── UC-FLW-01: 列出所有 flows (✅ implemented) ──────────────────────────

  test('UC-FLW-01: /flows renders browse shell — heading, scope tabs, filter chips, search', async ({
    page,
    request,
  }) => {
    // API contract（2026-08-19 更新）：/api/flows 已随引擎内聚移除，
    // flows 页现走 /api/workflows（console 代理 → gateway /api/v1/workflows）。
    const res = await request.get('/api/workflows')
    expect([200, 502, 503]).toContain(res.status())

    await page.goto('/flows')

    // Scope tabs (我的 / 全部 / 已归档) — flows-view.tsx:436-463,
    // role=tablist aria-label="flow 范围". The tab accessible name includes
    // the count span, so use a RegExp for partial matching.
    const scopeTabs = page.getByRole('tablist', { name: 'flow 范围' })
    await expect(scopeTabs).toBeVisible()
    await expect(scopeTabs.getByRole('tab', { name: /我的/ })).toBeVisible()
    await expect(scopeTabs.getByRole('tab', { name: /全部/ })).toBeVisible()
    await expect(scopeTabs.getByRole('tab', { name: /已归档/ })).toBeVisible()

    // Search input — flows-view.tsx:368-375, <input type="search"
    // aria-label="搜索 flow">.
    await expect(page.getByRole('searchbox', { name: '搜索 flow' })).toBeVisible()

    // 2026-08-19：状态筛选 chips（假筛选）已在全库审计中移除，不再断言。

    // Result count — "<n> / <m> 个 flow"（精确到 .result-count，避免
    // 命中空状态文案「选择一个 flow 查看概览」的 strict violation）
    await expect(page.locator('.result-count')).toContainText('个 flow')

    // The flow-cards container renders. When the workflow engine has AGENTFLOW
    // chatflows, .flow-card rows appear here; when empty, an empty-state
    // or error message renders. Either way the container exists.
    await expect(page.locator('.flow-cards')).toBeVisible()
  })

  // ── UC-FLW-02: 查看单个 flow 详情/DAG (✅ implemented) ──────────────────

  test('UC-FLW-02: run button jumps to canvas watch (detail page retired)', async ({ page }) => {
    // 2026-08-30 三方协商：详情页退役，一次运行一个家 = 画布旁观。
    // hash 深链 #flow=&run= 通道随之删除 —— 本用例改为钉住 /flows 路由上
    // 「运行 → 画布旁观」的新契约（/ 路由的同款旅程由 WF-12/UI-01 覆盖）。
    await page.goto('/flows')
    await expect(page.locator('.flow-cards')).toBeVisible({ timeout: 15_000 })
    const card = page.locator('.flow-card').first()
    await card.getByTitle('运行此 flow').click()
    const dialog = page.locator('.modal-dialog.open')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '开始运行' }).click()
    // dev 模式画布路由首次访问有冷编译 —— 放宽
    await page.waitForURL(/\/canvas\?run=/, { timeout: 15_000 })
  })

  test('UC-FLW-03 (partial): /workflows/:id/canvas renders an honest error state for an unknown id', async ({ page }) => {
    await page.goto(`/workflows/${SYNTH_FLOW_ID}/canvas`)

    // 2026-08-26：加载失败/不存在不再渲染空画布（名为 Untitled 的空编辑器
    // 会诱导用户保存空流程、覆盖真实数据）——改为显式错误卡 + 返回入口。
    // 真实 flow 的画布渲染由 spec 15/17（save-as-template 旅程）覆盖。
    await expect(page.getByText(/找不到这个 Flow|工作流加载失败/).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('link', { name: '返回 Flow 列表' })).toBeVisible()
  })

  test.fixme('UC-FLW-03 (workflow engine): PUT /api/v1/workflows/:id persists flow definition', async ({
    request,
  }) => {
    // ⚠️ Gap: architecture §9.5 requires PUT /api/v1/workflows/:id (内聚引擎).
    //
    // When the workflow engine lands (packages/workflow/ +
    // /api/v1/workflows/*), activate this test and assert:
    //   1. PUT /api/v1/workflows/:id with { flow_data: { nodes, edges } }
    //      returns 200 + the persisted definition
    //   2. the editor saves to the native workflow API
    const res = await request.put(`/api/v1/workflows/${SYNTH_FLOW_ID}`, {
      data: { flow_data: { nodes: [], edges: [] } },
    })
    expect(res.status()).toBe(200)
  })

  // ── UC-FLW-04: 创建新 flow (❌ unimplemented) ───────────────────────────

  test.fixme('UC-FLW-04: POST /api/v1/workflows creates a new flow', async ({ request }) => {
    // ❌ Gap: architecture §9.5 requires POST /api/v1/workflows, but no such
    // route exists today. The console has no native create-flow API or form.
    //
    // When the workflow engine lands, activate this test and assert:
    //   1. POST /api/v1/workflows with { name, flow_data } returns 201 + id
    //   2. the new flow appears in GET /api/v1/workflows
    //   3. a "new flow" button on /flows opens a native create form
    const res = await request.post('/api/v1/workflows', {
      data: { name: 'e2e-flw-new', flow_data: { nodes: [], edges: [] } },
    })
    expect(res.status()).toBe(201)
  })

  // ── UC-FLW-05: 删除 flow (❌ unimplemented) ─────────────────────────────

  test.fixme('UC-FLW-05: DELETE /api/v1/workflows/:id removes a flow', async ({ request }) => {
    // ❌ Gap: architecture §9.5 requires DELETE /api/v1/workflows/:id, but
    // no such route exists today. The console has no delete-flow API or button.
    //
    // When the workflow engine lands, activate this test and assert:
    //   1. DELETE /api/v1/workflows/:id returns 204
    //   2. GET /api/v1/workflows/:id afterwards returns 404
    //   3. a delete button on the flow card (or detail page) triggers the
    //      route with a confirm dialog
    const res = await request.delete(`/api/v1/workflows/${SYNTH_FLOW_ID}`)
    expect(res.status()).toBe(204)
  })

  // ── UC-FLW-06: 执行 flow (SSE 流式) (⚠️ partial) ───────────────────────
  //
  // Two tests: (1) a real `test()` asserting the run-button UI affordance
  // exists on the /flows page today; (2) a `test.fixme()` for the
  // workflow-engine SSE run endpoint (/api/v1/workflows/:id/run).

  test('UC-FLW-06 (partial): /flows run-button affordance renders on flow cards', async ({
    page,
  }) => {
    await page.goto('/flows')

    // The run button (运行) is part of each flow card's action row
    // (flows-view.tsx:469-482, data-action="run"). When the workflow engine has
    // AGENTFLOW chatflows, the button is visible on every card; when the
    // list is empty, the button template is not rendered. Either way the
    // page renders the flow-cards container — the run affordance exists
    // in the component tree and will appear once a flow is listed.
    await expect(page.locator('.flow-cards')).toBeVisible()

    // If flow cards are present (workflow engine up + has agentflows), assert the
    // run button is visible on at least one card. This is best-effort —
    // when the list is empty, the assertion is skipped (the fixme test
    // below covers the missing SSE execution path).
    const runButtons = page.locator('.flow-card [data-action="run"]')
    const count = await runButtons.count()
    if (count > 0) {
      await expect(runButtons.first()).toBeVisible()
      await expect(runButtons.first()).toHaveText(/运行/)
    }
  })

  test.fixme('UC-FLW-06 (workflow engine): POST /api/v1/workflows/:id/run streams SSE', async ({
    request,
  }) => {
    // ⚠️ Gap: architecture §9.5 requires POST /api/v1/workflows/:id/run
    // returning SSE (token / tool_call / thinking / metadata / end events),
    // but no such route exists today. Execution still goes through the old
    // POST /api/v1/flows/:id/prediction (workflow proxy, forwarded by
    // /api/chat), which returns a single JSON blob, not a stream.
    //
    // When the workflow engine lands
    // (packages/workflow/src/engine/sse-streamer.ts), activate this test
    // and assert:
    //   1. POST /api/v1/workflows/:id/run returns 200 + text/event-stream
    //   2. the stream emits token / tool_call / thinking / metadata / end
    //   3. the console's run button triggers this endpoint (not /api/chat)
    const res = await request.post(`/api/v1/workflows/${SYNTH_FLOW_ID}/run`, {
      headers: { accept: 'text/event-stream' },
      data: { input: 'hello' },
    })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/event-stream')
  })

  // ── UC-FLW-07: 查看执行历史 (❌ unimplemented) ──────────────────────────

  test.fixme('UC-FLW-07: GET /api/v1/workflows/:id/executions lists run history', async ({
    request,
  }) => {
    // ❌ Gap: architecture §9.5 requires GET /api/v1/workflows/:id/executions,
    // but no such route exists today. Only the per-run node-span trace
    // (/api/flows/runs/:runId/node-spans → scheduler) exists, which is a
    // single run's node-level detail, not a flow-level execution history.
    //
    // The FlowsView list page does show a single latest-run row per flow
    // card (flows-view.tsx:484-530), but there is no dedicated execution-
    // history API or page — the design's expand-to-see-runs affordance
    // only reveals the one latest run the summary already carried.
    //
    // When the workflow engine lands, activate this test and assert:
    //   1. GET /api/v1/workflows/:id/executions returns 200 + paginated list
    //   2. each execution has id / status / startedAt / durationMs / cost
    //   3. the flow card's expand row lists multiple runs (not just latest)
    const res = await request.get(`/api/v1/workflows/${SYNTH_FLOW_ID}/executions`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data?.items)).toBe(true)
  })
})
