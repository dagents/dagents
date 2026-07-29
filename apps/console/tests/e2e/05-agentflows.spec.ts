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
 *       the run button (▶ 运行) on each flow card opens the detail view,
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
    // API contract: GET /api/flows exists (workflow proxy). Tolerate 502/503
    // when the workflow engine is down — the route existing is what we assert;
    // the page renders the shell regardless of upstream state.
    const res = await request.get('/api/flows')
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

    // Status filter chips (运行中 / 已完成 / 已暂停 / 失败) —
    // flows-view.tsx:376-388, the four STATUS_FILTERS rendered as buttons.
    await expect(page.getByRole('button', { name: '运行中' })).toBeVisible()
    await expect(page.getByRole('button', { name: '已完成' })).toBeVisible()
    await expect(page.getByRole('button', { name: '已暂停' })).toBeVisible()
    await expect(page.getByRole('button', { name: '失败' })).toBeVisible()

    // Result count — flows-view.tsx:390-392, "<n> / <m> 个 flow".
    await expect(page.getByText(/个 flow/)).toBeVisible()

    // The flow-cards container renders. When the workflow engine has AGENTFLOW
    // chatflows, .flow-card rows appear here; when empty, an empty-state
    // or error message renders. Either way the container exists.
    await expect(page.locator('.flow-cards')).toBeVisible()
  })

  // ── UC-FLW-02: 查看单个 flow 详情/DAG (✅ implemented) ──────────────────

  test('UC-FLW-02: flow detail page renders DAG canvas + inspector via hash deep-link', async ({
    page,
  }) => {
    // The detail page is swapped in by FlowsView when both selectedFlowId +
    // selectedRunId are set (flows-view.tsx:321 `inDetail`). The hash
    // deep-link `#flow=…&run=…` is the design's entry point
    // (flows-view.tsx:250-268 applyHash). Using a synthetic id — the fetch
    // to /api/flows/:id will 502 (no such chatflow), but the detail
    // page structure (back button + canvas wrap + inspector + legend)
    // renders regardless; the error message lands inside the canvas wrap.
    await page.goto(`/flows#flow=${SYNTH_FLOW_ID}&run=${SYNTH_RUN_ID}`)

    // The detail page becomes active (.flow-detail-page.active →
    // display:block, shell.css:787-788). The back button is the clearest
    // signal — flows-view.tsx:545-553, aria-label="返回 AgentFlows 列表".
    // Generous timeout: the hash effect fires on mount, sets state, and
    // the re-render swaps the page.
    await expect(page.getByRole('button', { name: '返回 AgentFlows 列表' })).toBeVisible({
      timeout: 10_000,
    })

    // The detail page's two-column layout: canvas wrap + inspector.
    // flows-view.tsx:555-614 (.flow-layout > .flow-canvas-wrap +
    // .flow-inspector). Both containers are always present once the detail
    // page is active, regardless of whether the flow fetch succeeded.
    await expect(page.locator('.flow-canvas-wrap')).toBeVisible()
    await expect(page.locator('.flow-inspector')).toBeVisible()

    // The legend bar (运行/完成/排队/失败/人工暂停/未触发) is always
    // rendered below the canvas (flows-view.tsx:585-593) — a stable
    // signal that the detail page's canvas column rendered.
    const legend = page.locator('.legend-flow')
    await expect(legend).toBeVisible()
    await expect(legend.getByText('运行', { exact: true })).toBeVisible()
    await expect(legend.getByText('完成', { exact: true })).toBeVisible()
  })

  // ── UC-FLW-03: 编辑 flow (workflow editor) (⚠️ partial) ─────────────────
  //
  // Two tests: (1) a real `test()` asserting the edit route renders the
  // native workflow canvas today; (2) a `test.fixme()` for the workflow-
  // engine migration (PUT /api/v1/workflows/:id).

  test('UC-FLW-03 (partial): /workflows/:id/canvas renders native workflow canvas', async ({ page }) => {
    await page.goto(`/workflows/${SYNTH_FLOW_ID}/canvas`)

    // PageShell title → <h1>Workflow Canvas</h1> (canvas/page.tsx).
    await expect(page.getByRole('heading', { name: /workflow/i, level: 1 })).toBeVisible()

    // The canvas page renders a React Flow canvas container.
    // The canvas element is present even when the workflow API is down —
    // the UI renders first, then fetches data.
    const canvasEl = page.locator('.react-flow')
    await expect(canvasEl).toBeVisible({ timeout: 10_000 })
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

    // The run button (▶ 运行) is part of each flow card's action row
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
