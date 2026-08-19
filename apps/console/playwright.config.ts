import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the console package (v0.3-M10.1).
 *
 * The design-fidelity e2e (tests/e2e/v0.3-design.spec.ts) exercises the two
 * flows the audit pinned as acceptance for v0.3: the new-task composer's
 * Path B (direct-agent dispatch) → gateway POST contract + agent-detail
 * presence-pill render (the WS-refresh e2e is deferred — see the spec header),
 * and the flows edit button opening the workflow canvas editor.
 * The webServer block boots `next dev` on :3000 and reuses an already-running
 * instance so a developer's `pnpm --filter @dagents/console dev` is not killed
 * between runs.
 *
 * These are **true end-to-end** tests, not the in-process `app.request()`
 * suites under `__tests__/`. They need the dagents dev stack up: Postgres
 * (:15432), Redis (:16479), and the gateway (:8080) + dispatch (:8081) +
 * workflow services the console proxies into. See the issue brief and
 * `infra/README.md` for bring-up. The webServer here only owns the Next dev
 * process — the rest is expected to already be running (reuseExistingServer
 * makes a shared dev stack the happy path).
 *
 * Port: defaults to 3000 (the design's console port). Override with
 * `E2E_PORT` to target an already-running dev server on another port — this
 * workspace has another Next app parked on :3000, so MZW-309's viewport matrix
 * already runs against a console booted on a free port pointed at via
 * `E2E_PORT`; the same override works for the design-fidelity suite.
 *
 * Auth: none — login was removed (本机模式), the gateway runs open. These e2e
 * POST the gateway directly (`/api/v1/tasks`) and rely on the agents picker
 * resolving from `/api/agents`; no login bootstrap is needed.
 *
 * Browsers: Chromium only. The 9-viewport visual matrix is MZW-309 (M10.2),
 * not here.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? '3000'}`,
    headless: true,
    // `retain-on-failure` (not `on-first-retry`) because local `retries:0` means
    // the on-first-retry trace would never fire — a local flake would leave no
    // trace/screenshot to debug. This writes a trace for any failed local run;
    // CI keeps `on-first-retry`'s behavior implicitly via retries:1 + retain.
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // 两个进程：console dev server + Mock LLM Provider（docs/e2e-test-plan.md §4.4）。
  // mock 是零依赖 node:http 进程（端口 4010，E2E_MOCK_LLM_PORT 可覆盖），
  // 供执行态用例把 LLM/Agent/PlatformAgent 节点钉在确定响应上。
  webServer: [
    {
      command: 'node tests/e2e/fixtures/mock-llm-server/server.mjs',
      url: `http://127.0.0.1:${process.env.E2E_MOCK_LLM_PORT ?? '4010'}/__control/health`,
      reuseExistingServer: true,
      timeout: 15_000,
      stdout: 'ignore',
      stderr: 'pipe',
      cwd: __dirname,
      env: { ...process.env, E2E_MOCK_LLM_PORT: process.env.E2E_MOCK_LLM_PORT ?? '4010' },
    },
    {
      // Boot the console's `next dev` if it isn't already up. reuseExistingServer
      // lets a developer keep their own console dev running and have Playwright
      // attach to it instead of spawning a second instance. Point at a different
      // port (e.g. another Next app occupies :3000) via `E2E_PORT`.
      command: 'pnpm --filter @dagents/console exec next dev -p ' + (process.env.E2E_PORT ?? '3000'),
      url: `http://127.0.0.1:${process.env.E2E_PORT ?? '3000'}`,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      cwd: __dirname,
    },
  ],
})
