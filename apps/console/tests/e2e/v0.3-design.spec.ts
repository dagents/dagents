import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'

/**
 * v0.3 design-fidelity e2e (plan Task M10.1).
 *
 * Two scenarios from the v0.3 epic (MZW-285). After the architecture review,
 * the acceptance bar for scenario 1 was **downgraded** — read this header
 * before touching the tests; it is the source of truth for what they claim.
 *
 *   1. **new-task Path B (agent) — gateway POST contract + agent-detail pill.**
 *      This is NOT a full "submit → direct run → WS live-status refresh" e2e.
 *      Three capabilities that the full acceptance would need are not in place
 *      yet: (a) the console has no "path badge" UI that renders `direct`/`flow`
 *      anywhere (a grep for the badge markup returns nothing), (b) the gateway
 *      `POST /api/v1/tasks` route does **not** emit any `agent-updated` WS frame
 *      on task creation (no `wsHub` call in `apps/gateway/src/routes/tasks.ts`),
 *      and (c) the workspace `?new=1` consumer (the composer's real send
 *      hand-off) lands in a later task. So this scenario asserts only the two
 *      things that actually exist today, and does **not** imply it verified a
 *      WS refresh:
 *        - the gateway's `POST /api/v1/tasks` contract for assigneeType=agent
 *          (Path B): `success:true` + `data.path==='direct'` + a non-empty
 *          `data.runId`. The composer's UI submit is exercised too (picker
 *          open → option click → textarea → ⏎), but the run itself is created
 *          by the direct POST, not the composer hand-off.
 *        - the agent-detail page `/agents/:id` renders a live-presence pill
 *          (在线/不稳定/离线) — i.e. the view wired to the agents catalogue and
 *          resolved an initial availability. This is independent of the just-
 *          created task (the pill is seeded by the REST `GET /agents/:id`, not
 *          by a WS frame from task creation); it is asserted only as "the pill
 *          renders", not "the pill refreshed because of this task".
 *
 *      The full WS-refresh e2e is deferred to a follow-up issue, to be added
 *      once the gateway emits an `agent-updated` WS frame on task creation and
 *      the path-badge UI lands. Until then this spec must not hint that it
 *      verified a WS refresh.
 *
 *   2. **flows edit button → Flowise canvas iframe.**
 *      On `/flows`, the first flow-card's `[data-action=edit]` button routes
 *      to `/flows/<id>/edit`, where `FlowEditorFrame` (M2.3) renders an
 *      `<iframe title="Flowise 画布编辑器">` embedding the Flowise native
 *      canvas. We assert the URL shape and that the iframe **element** is
 *      visible with a src containing `/canvas/`. We deliberately do NOT assert
 *      on the cross-origin iframe's inner `:root` — see the note at the
 *      assertion site.
 *
 * ## What these tests need at runtime
 *
 * The console proxies everything through the gateway, so the full mil-agents
 * dev stack must be up: Postgres (:15432) + Redis (:16479) + gateway (:8080)
 * + dispatch (:8081) + Flowise (:3100, with `IFRAME_ORIGINS` permitting the
 * console origin so the canvas iframe is frame-ancestors-allowed). The
 * `playwright.config.ts` webServer only owns the Next dev process (baseURL,
 * :3000 by default — override with `E2E_PORT`); the spec navigates with paths
 * relative to that baseURL.
 *
 * ### Auth (review #4)
 * `postDirectTask` POSTs the gateway directly and the picker resolves from
 * `/api/agents`. The gateway's SSO session gate is a no-op when
 * `SSO_SESSION_SECRET` is unset, and `REQUIRE_LOGIN=1` is only honored when
 * SSO is configured — so a plain dev stack (no SSO) runs auth-free. On a stack
 * with SSO + `REQUIRE_LOGIN=1`, the POST would 401; `postDirectTask` asserts
 * the HTTP status so a 401 surfaces as a clear failure rather than a
 * misleading `success:false` assertion. Run e2e against an SSO-gated-off
 * stack, or arrange a dev login first.
 *
 * ### Agent seed (review #5)
 * The picker reads from the dispatch `agent_daemons` catalogue table, and the
 * repo has **no committed seed** for it (no migration/infra inserts a row, and
 * — importantly — there is **no API route that creates an `agent_daemons`
 * row**: the gateway/dispatch `/agents*` routes are GET-only, and
 * `POST /daemons/register` inserts only the `daemons` host row, not the
 * `agent_daemons` catalogue row). So a fresh `docker compose up` + migrate
 * leaves the picker empty, and the review's "create the agent via API in
 * setup" cannot be done literally — the create-agent surface does not exist
 * yet.
 *
 * `beforeAll` therefore self-seeds the agent the way the repo's own DB-touching
 * e2e does (`packages/e2e/src/setup.ts`): it registers a daemon via the real
 * `POST /daemons/register` API, then inserts the `agent_daemons` catalogue row
 * directly via `@mil/db`'s `runQuery` (the platform's DB layer — the same
 * helper every gateway/dispatch route uses). `afterAll` deletes the task, run,
 * agent_daemons row, and daemon the run created, so the stack is left clean.
 * This makes the test runnable against a brand-new stack with no hand-inserted
 * rows. When a create-agent API route lands, the `runQuery` insert should be
 * swapped for that route call — the gap is noted at the insert site.
 *
 * See the issue brief and `infra/README.md` for the bring-up sequence.
 */

// The agent label the self-seeded agent_daemons row uses. The picker matches
// the option by exact name (review #8) and reads the live id off its data-id,
// so nothing hardcodes a UUID. Override via env when you want a different label.
const E2E_AGENT_NAME = process.env.E2E_AGENT_NAME ?? 'e2e-agent'

// A flow id that exists in the Flowise (dev) chatflows list so the `/flows`
// browse page renders at least one card with a `[data-action=edit]` button.
// Empty = don't assert a specific id, just the /flows/<id>/edit URL shape.
const E2E_FLOW_ID = process.env.E2E_FLOW_ID ?? ''

// A workspace id the POST /api/v1/tasks body requires (tasks.workspace_id is a
// non-null UUID with no FK — the entity notes no-cascade — so the nil UUID is
// accepted as a ghost workspace by the gateway; the dev stack does not need a
// real workspace row for this contract check). Override with a real id when
// the seed differs.
const E2E_WORKSPACE_ID = process.env.E2E_WORKSPACE_ID ?? '00000000-0000-0000-0000-000000000000'

const GATEWAY_BASE = process.env.E2E_GATEWAY_URL ?? 'http://localhost:8080'
// Dispatch is reached through the gateway's `/api/v1/dispatch/*` blind proxy
// (apps/gateway/src/app.ts `app.all('/api/v1/dispatch/*')`), so agent/daemon
// setup goes via the gateway too — one base URL, one auth posture.
const DISPATCH_BASE = `${GATEWAY_BASE}/api/v1/dispatch`

// The dev-stack Postgres (compose remaps 5432→15432 to avoid host collisions).
// `beforeAll` sets this on `process.env` *before* dynamically importing
// `@mil/db`, because `@mil/db`'s `AppDataSource` captures `POSTGRES_URL` at
// module-construction time — setting it after a static import would be too late
// (the DataSource would already be built against the :5432 default). The
// dynamic import inside `beforeAll` guarantees the env is set first.
const E2E_POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://milagents:milagents_dev@localhost:15432/milagents'

/** IDs of the rows `beforeAll` creates; cleaned up by `afterAll`. */
let seededAgentId = ''
let seededDaemonId = ''
/** IDs of the task/run scenario 1 creates; cleaned up by `afterAll`. */
let createdTaskId = ''
let createdRunId = ''

/**
 * Self-seed a daemon + agent_daemons row so the new-task picker has an option
 * to pick on a fresh stack (review #5). The daemon host is created via the real
 * `POST /daemons/register` API; the `agent_daemons` catalogue row is inserted
 * via `@mil/db` `runQuery` because no create-agent API route exists today (see
 * the spec header's "Agent seed" note). Returns the agent_daemons id.
 *
 * `@mil/db` is pulled in via the workspace symlink (it is not a declared
 * console dependency — this is test-only tooling, not app code; the console app
 * itself never touches the DB layer, only the gateway). `initDb` is idempotent.
 */
async function seedAgent(request: APIRequestContext): Promise<{ agentId: string; daemonId: string }> {
  // Set the env BEFORE the dynamic import so AppDataSource picks up :15432.
  process.env.POSTGRES_URL = E2E_POSTGRES_URL
  const { initDb, runQuery } = await import('@mil/db')
  await initDb()

  // Register the daemon host via the real dispatch API. `endpoint` is optional
  // in the register schema; we omit it (no real daemon process is serving
  // claims — the picker only needs the catalogue row to exist). The daemon is
  // created with status 'online' so the agent-detail presence pill derives
  // `online` (在线) — the pill assertion's happy path.
  const reg = await request.post(`${DISPATCH_BASE}/daemons/register`, {
    data: {
      daemonLabel: `e2e-daemon-${randomUUID().slice(0, 8)}`,
      capabilities: [{ agentType: 'claude', tags: ['e2e'] }],
    },
  })
  // Assert the HTTP status (review #4 spirit) so a setup failure surfaces as a
  // clear status, not a downstream `agentId` falsy check.
  expect(reg.ok(), `daemon register should be 2xx, got ${reg.status()}`).toBe(true)
  const regBody = (await reg.json()) as { data: { daemonId: string } }
  const daemonId = regBody.data.daemonId
  expect(daemonId).toBeTruthy()

  // Insert the agent_daemons catalogue row. Mirrors the column set the dispatch
  // test helpers use (`apps/dispatch/src/__tests__/agents.test.ts:50`). The
  // `capability_descriptor` JSONB carries the name/summary the catalogue maps;
  // `visibility` is 'private' (the design's default). RETURNING id so we get the
  // UUID minted by gen_random_uuid() without a second round-trip.
  //
  // TODO(create-agent API): when a `POST /agents` (or a daemon-register flow
  // that also creates the agent_daemons row) lands, replace this `runQuery`
  // insert with that API call so the seed goes end-to-end through HTTP, not the
  // DB layer. Tracked as a follow-up; the missing create-agent surface is the
  // reason this DB write exists.
  const { records } = await runQuery<{ id: string }>(
    `INSERT INTO agent_daemons
       (name, kind, daemon_id, capability_descriptor, executable_path, visibility)
     VALUES ($1, 'claude', $2, $3::jsonb, 'claude', 'private')
     RETURNING id`,
    [
      E2E_AGENT_NAME,
      daemonId,
      JSON.stringify({
        name: E2E_AGENT_NAME,
        summary: 'e2e seed agent for v0.3 design-fidelity spec',
        inputSchema: '{}',
        outputSchema: '{}',
        tags: ['e2e'],
      }),
    ],
  )
  const agentId = records[0]?.id
  expect(agentId, 'agent_daemons insert should RETURNING an id').toBeTruthy()
  return { agentId: agentId!, daemonId }
}

/**
 * Best-effort teardown of every row the run created: the task + run (scenario
 * 1's POST /tasks), the agent_daemons catalogue row, and the daemon host. None
 * of these have FKs that block deletion (tasks/runs/agent_daemons reference
// each other only via plain TEXT/UUID columns with indexes, no REFERENCES), so
 * the order is defensive but not load-bearing. A teardown failure does NOT fail
 * the run — it is logged — so cleanup never masks the real test result.
 */
async function teardown(request: APIRequestContext): Promise<void> {
  process.env.POSTGRES_URL = E2E_POSTGRES_URL
  const { runQuery } = await import('@mil/db')

  // Delete the run + task scenario 1 created (if any). runs/tasks have no FK
  // between them, so either order is safe; run first, then task.
  if (createdRunId) {
    await runQuery('DELETE FROM runs WHERE id = $1::uuid', [createdRunId]).catch(() => {})
  }
  if (createdTaskId) {
    await runQuery('DELETE FROM tasks WHERE id = $1::uuid', [createdTaskId]).catch(() => {})
  }
  // Delete the agent_daemons catalogue row (no FK to dispatch_tasks today, so
  // no cascade concern; the task we created above is already gone).
  if (seededAgentId) {
    await runQuery('DELETE FROM agent_daemons WHERE id = $1::uuid', [seededAgentId]).catch(() => {})
  }
  // Delete the daemon host via the real API. `agent_daemons.daemon_id` has
  // `ON DELETE CASCADE` from `daemons`, so this would also drop a lingering
  // agent_daemons row — but we already deleted it above, so this is belt-and-
  // braces. Best-effort: a non-204 is logged, not thrown.
  if (seededDaemonId) {
    const del = await request.delete(`${DISPATCH_BASE}/daemons/${seededDaemonId}`)
    if (!del.ok()) {
      // eslint-disable-next-line no-console
      console.warn(`e2e teardown: daemon delete returned ${del.status()} for ${seededDaemonId}`)
    }
  }
}

/**
 * POST a task to the gateway's `/api/v1/tasks` with assigneeType=agent
 * (Path B / direct), returning the response body. The console's new-task
 * composer currently hand-offs to `/workspace?new=1&...` (design `doSend` does
 * not POST); the gateway route is the plan's prescribed POST contract
 * (`apps/gateway/src/routes/tasks.ts`). Using it directly here isolates the
 * Path B assertion from the workspace `?new=1` consumer (a later task) and
 * exercises the real gateway→runs code path end-to-end.
 *
 * The gateway returns `{ success, data: { task, runId, path } }` (the route's
 * `ok()` envelope wraps the body as `{ success: true, data: body }`). We
 * assert the HTTP status (review #4) so an auth 401 / 4xx surfaces as a clear
 * status failure before the body is parsed — a 401 from a `REQUIRE_LOGIN=1`
 * stack would otherwise look like a confusing `success:false` assertion.
 */
async function postDirectTask(page: Page, opts: { task: string; agentId: string }): Promise<{
  status: number
  success: boolean
  data?: { runId?: string; path?: string; task?: { id?: string; status?: string; runId?: string } }
  error?: string
}> {
  const res = await page.request.post(`${GATEWAY_BASE}/api/v1/tasks`, {
    data: {
      title: opts.task,
      assigneeType: 'agent',
      assigneeId: opts.agentId,
      creatorId: 'e2e-test',
      workspaceId: E2E_WORKSPACE_ID,
    },
  })
  // Surface auth/contract failures as a clear status assertion. A 401 (SSO
  // gate on a REQUIRE_LOGIN stack) or a 4xx (bad body) fails here with the
  // real status, instead of parsing a non-2xx body and failing later on a
  // misleading `success` check.
  expect(res.ok(), `POST /api/v1/tasks should be 2xx, got ${res.status()}`).toBe(true)
  const body = (await res.json()) as {
    success: boolean
    data?: { runId?: string; path?: string; task?: { id?: string; status?: string; runId?: string } }
    error?: string
  }
  return { status: res.status(), ...body }
}

// ── Setup/teardown: self-seed a picker agent so a fresh stack runs (review #5)

test.beforeAll(async ({ request }) => {
  const { agentId, daemonId } = await seedAgent(request)
  seededAgentId = agentId
  seededDaemonId = daemonId
})

test.afterAll(async ({ request }) => {
  await teardown(request)
})

// ─── Scenario 1: new-task Path B (agent) → direct path + agent-detail pill ───

test('new-task Path B (agent): gateway POST contract (path=direct + runId) + agent-detail pill renders', async ({ page }) => {
  // The composer: open /tasks/new, pick the agent, type, submit. This exercises
  // the real new-task view wiring (picker open → option click → textarea →
  // ⏎ send → router.push handoff) against the live console. The agents list
  // must resolve from /api/agents (gateway → dispatch → DB) for the picker to
  // show the option — `beforeAll` seeded that row. The option's `data-id` is
  // the real agent UUID — read it off the clicked option so the POST +
  // agent-detail nav use the live id rather than a hardcoded value. Navigates
  // relative to baseURL (review #7).
  await page.goto('/tasks/new')

  await page.getByRole('button', { name: '关联 Agent' }).click()
  // The agent picker is a role=dialog「选择 Agent」; each option is a button
  // whose accessible name is the concatenated text of its child spans:
  // `<glyph><name><meta>` (new-task-view.tsx renders the glyph = `name.slice(-2)`,
  // the agent name, and the `${kind} · ${roles}` meta as sibling spans inside
  // the button, with no aria-label). Playwright's accessible-name computation
  // joins those spans with a space, so for the seeded `e2e-agent`
  // (glyph='nt', kind=claude, tag=e2e) the accessible name is
  // `nt e2e-agentclaude · e2e`. Match that whole string exactly (review #8:
  // exact, not a partial RegExp + .first()) — a RegExp would also match
  // `e2e-agent-2` etc. nondeterministically. The glyph/meta are derived from
  // the seed's name+kind+tags, so this string is stable for the one seeded
  // option; if E2E_AGENT_NAME is overridden the glyph (last 2 chars) changes
  // with it.
  const agentOption = page.getByRole('button', {
    name: `${E2E_AGENT_NAME.slice(-2)} ${E2E_AGENT_NAME}claude · e2e`,
    exact: true,
  })
  await expect(agentOption).toBeVisible({ timeout: 10_000 })
  // Resolve the live agent id from the option's data-id (the seed minted a
  // UUID; matching by accessible name keeps the test seed-agnostic for the id
  // column).
  const agentId = await agentOption.getAttribute('data-id')
  expect(agentId).toBeTruthy()
  // Pick the option with a normal hit-tested click. The picker's z-index was
  // raised to 110 on main (apps/console/src/styles/new-task.css, review #2) so
  // it now sits above the `.drawer-backdrop` (80) and receives the pointer
  // event — no `force: true` is needed. The earlier `force: true` masked the
  // pre-fix stacking bug (picker z-index:50 under the backdrop's 80); it was
  // dropped on the rebase after that CSS landed.
  await agentOption.click()

  await page.getByLabel('任务描述').fill('列出当前目录')
  await page.keyboard.press('Enter')

  // The composer hand-offs to /workspace?new=1&... (design doSend). The run
  // is created by the gateway POST /api/v1/tasks (Path B / direct). Assert
  // the direct path directly against the gateway contract — the workspace
  // ?new=1 consumer is a later task (per the M3.1 picker test's scope note).
  // This is the gateway POST contract half of the (downgraded) acceptance;
  // it does NOT verify a WS refresh (see the spec header).
  const created = await postDirectTask(page, { task: '列出当前目录', agentId: agentId! })
  expect(created.success).toBe(true)
  expect(created.data?.path).toBe('direct')
  expect(created.data?.runId).toBeTruthy()
  // Stash the created ids so afterAll can clean up the task + run rows.
  createdTaskId = created.data?.task?.id ?? ''
  createdRunId = created.data?.runId ?? ''

  // Agent-detail presence pill: the view fetches /api/agents/:id on mount and
  // renders the live-presence pill (在线/不稳定/离线). This is the "pill
  // renders" half of the (downgraded) acceptance — it confirms the detail
  // page wired to the agents catalogue and resolved an initial availability.
  // It does NOT assert the pill refreshed because of the task just created:
  // the gateway POST /tasks emits no `agent-updated` WS frame today, so the
  // pill state comes from the REST seed, independent of this task. The full
  // WS-refresh e2e is a follow-up (see spec header).
  await page.goto(`/agents/${encodeURIComponent(agentId!)}`)
  const presence = page.locator('.ins-presence .status').first()
  await expect(presence).not.toBeEmpty({ timeout: 10_000 })
  await expect(presence).toHaveText(/在线|不稳定|离线/)
})

// ─── Scenario 2: flows edit button → Flowise canvas iframe ───────────────

test('flows edit button opens the Flowise canvas iframe editor', async ({ page }) => {
  await page.goto('/flows')

  // The first flow-card's edit button (data-action=edit) routes to
  // /flows/<id>/edit. Wait for the list to render at least one card.
  const editButton = page.locator('[data-action=edit]').first()
  await expect(editButton).toBeVisible({ timeout: 15_000 })
  await editButton.click()

  // URL shape: /flows/<id>/edit. If E2E_FLOW_ID is set, assert it lands there;
  // otherwise just assert the edit suffix (the id is whatever the live list had).
  await expect(page).toHaveURL(/\/flows\/.+\/edit$/)
  if (E2E_FLOW_ID) {
    await expect(page).toHaveURL(new RegExp(`/flows/${E2E_FLOW_ID}/edit$`))
  }

  // The FlowEditorFrame (M2.3) renders an iframe titled「Flowise 画布编辑器」
  // whose src is <flowiseEditorUrl()>/canvas/<id>. Assert the iframe **element**
  // is visible and its src points at the canvas route (review #3).
  //
  // We assert on the <iframe> element itself, NOT its inner `:root`. Flowise
  // runs cross-origin to the console (:3100 vs the console's dev port);
  // Playwright can always see the <iframe> element in the parent document, but
  // probing into a cross-origin frame's `:root` requires the frame's document
  // to be frame-ancestors-allowed AND navigable — if `IFRAME_ORIGINS` isn't
  // set, the browser still renders the <iframe> element (with a blocked/error
  // document inside), and a `:root` assertion would hang to the 15s timeout or
  // throw. The honest contract is "the editor iframe is present and points at
  // the canvas route" — which the element-level visibility + src check below
  // covers.
  const editorIframe = page.locator('iframe[title="Flowise 画布编辑器"]')
  await expect(editorIframe).toBeVisible({ timeout: 15_000 })

  const iframeSrc = await editorIframe.getAttribute('src')
  expect(iframeSrc).toBeTruthy()
  expect(iframeSrc).toMatch(/\/canvas\//)
})
