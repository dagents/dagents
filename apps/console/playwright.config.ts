import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the console package — full browser e2e suite
 * (`tests/e2e/`：UC 用户用例 spec 01~10 + 执行态 spec 11~23 + viewport-matrix).
 *
 * These are **true end-to-end** tests, not the in-process `app.request()`
 * suites under `__tests__/`. They need the dagents dev stack up: Postgres
 * (:15432 本机；CI 用 fresh 服务容器直建 `dagents_e2e`) and the gateway
 * (:8080 —— dispatch/scheduler/workflow 引擎均已并入 gateway，无独立服务，
 * Redis 依赖已废弃). The `webServer` array owns exactly two processes:
 *  1. Mock LLM Provider（:4010，`E2E_MOCK_LLM_PORT` 可覆盖；OpenAI 兼容 +
 *     `/__control/*` 控制面，docs/e2e-test-plan.md §4.4）—— 执行态用例的
 *     确定性地基；
 *  2. console `next dev`（默认 :3000，`E2E_PORT` 可指向已占用另一端口的
 *     实例）；`reuseExistingServer: true` 让本地已跑的 dev stack 直接复用.
 *
 * Auth: none — login was removed (本机模式), the gateway runs open. No login
 * bootstrap is needed.
 *
 * Browsers: Chromium only（viewport-matrix 的 10 屏 × 9 视口矩阵是同目录的
 * `viewport-matrix.spec.ts`，同一 config 覆盖）.
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
