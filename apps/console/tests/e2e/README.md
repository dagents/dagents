# Chat-First E2E Test Harness

> **Scope:** Playwright browser e2e for the Chat-First user-facing surface.
> **Coverage:** 67 user cases from `docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md`, organized into 10 modules; **plus** the workflow-execution / multi-Agent suite from `docs/e2e-test-plan.md`（spec 11~15，2026-08-19 落地）.
> **Status:** 36 active + 43 fixme（UC 套件）+ **50 active（执行态套件 11~15，含多 Agent 协作专项）**.

This directory holds the **user-case e2e suite** — true end-to-end tests that drive a real browser through the Chat-First UI. They assert what the user sees and what the HTTP contract returns, not internal code behavior. Each test maps to a numbered user case (UC-ID) in the gap analysis.

Backend integration is covered by gateway route tests (`apps/gateway/src/__tests__/`, vitest + `app.request()`) — no separate in-process backend e2e suite exists today (原 `packages/e2e` 闭链套件已于 2026-08-16 审计中删除).

---

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Running the Suite](#running-the-suite)
- [Test Inventory](#test-inventory)
- [Writing a New Test](#writing-a-new-test)
- [Seed/Cleanup Helpers](#seedcleanup-helpers)
- [Strategy: `test.fixme` for Unimplemented Features](#strategy-testfixme-for-unimplemented-features)
- [Debugging](#debugging)
- [Maintenance](#maintenance)

---

## Quick Start

```bash
# 1. Bring up the dev stack (Postgres via infra; gateway 含 dispatch/scheduler/workflow 引擎)
cd infra && docker compose up -d && cd ..
pnpm --filter @dagents/gateway dev &

# 2. Run the full e2e suite (boots Next dev on :3000 automatically)
pnpm --filter @dagents/console test:e2e

# 3. Or run a single module
pnpm --filter @dagents/console exec playwright test tests/e2e/03-directories.spec.ts
```

---

## Prerequisites

The e2e suite needs the dev stack up（dispatch/scheduler 已并入 gateway，无独立服务；Redis 依赖已废弃）:

| Service | Port | Why |
|---------|------|-----|
| Postgres | `:15432` | directories / chats / chat_messages / runs / agents tables |
| Gateway | `:8080` | `/api/v1/chats/*`, `/api/v1/directories/*`, `/api/v1/agents/*`, `/api/v1/workflows/*` + dispatch 协议路由 |
| Console (Next) | `:3000` | Auto-booted by Playwright's `webServer` config — no need to start manually |

### Environment variables

| Var | Default | When to override |
|-----|---------|------------------|
| `POSTGRES_URL` | `postgresql://dagents:dagents_dev@localhost:15432/dagents` | Pointing at a non-default stack |
| `E2E_GATEWAY_URL` | `http://localhost:8080` | Gateway on a different port |
| `E2E_PORT` | `3000` | Console on a different port (avoids conflicts with another Next app on :3000) |
| `E2E_MOCK_LLM_PORT` | `4010` | Mock LLM Provider 端口（执行态套件 11~15 的确定性地基，见下） |

### Mock LLM Provider（执行态套件的确定性地基）

`fixtures/mock-llm-server/server.mjs` 是一个零依赖的 OpenAI 兼容 mock（node:http，
由 playwright `webServer` 数组与 console 一起拉起）。执行态 spec 在 `beforeAll`
里 `seedMockLlmProvider(ctx)` 把 active provider 指到它 —— 此后所有 LLM/Agent/
PlatformAgent 节点的响应都可脚本化、可在 `/__control/calls` 断言（「谁收到什么
prompt / 工具是否回灌 / 循环了几轮」的协作证据），不再依赖真实 CLI/模型。

- `POST /__control/script` 设置规则（`match.systemContains/userContains/…` +
  `respond.text/toolCalls/delayMs/mode:error|malformed|hang|toolLoop`）；
- `GET /__control/calls` 调用记录、`POST /__control/reset` 清空。
- ⚠️ 套件跑完 `dispose()` 会删掉插入的 provider 行并恢复原状；**若中途强杀
  测试，dev 库可能残留 `e2e-mock-%` active 行**（此时真实 LLM 调用会指向死
  mock）—— 清理：`DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%'`。

### 专用测试库（可选，全栈隔离）

`docs/e2e-test-plan.md` §4.4 的专用库 `dagents_e2e` 已建好（本机 :15432）。
完全隔离需要 gateway 也指向它（seed.ts 只控制测试进程的直连读写）：

```bash
# 1. gateway 指向专用库重启（GATEWAY_PORT 可换端口并行跑）
POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents_e2e \
  GATEWAY_PORT=8081 pnpm --filter @dagents/gateway dev &

# 2. 套件指向该 gateway + 专用库
POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents_e2e \
  E2E_GATEWAY_URL=http://127.0.0.1:8081 pnpm --filter @dagents/console test:e2e
```

不重启 gateway 时套件退化为 dev 库 + 全套 seed/cleanup（默认路径，已稳定）。
CI（`.github/workflows/e2e.yml`）用 fresh Postgres 服务容器直建 `dagents_e2e`。

### Auth posture

Login was removed — the stack runs **auth-free** by design (本机模式). No login bootstrap is needed for e2e.

---

## Running the Suite

```bash
# Full suite (all 10 spec files, serial — workers:1 in config)
pnpm --filter @dagents/console test:e2e

# Single spec file
pnpm --filter @dagents/console exec playwright test tests/e2e/01-chat-home.spec.ts

# Single UC (by test name substring)
pnpm --filter @dagents/console exec playwright test -g "UC-CHAT-04"

# With UI mode (interactive watcher — recommended when writing new tests)
pnpm --filter @dagents/console exec playwright test --ui

# Headed mode (watch the browser)
pnpm --filter @dagents/console exec playwright test --headed

# Generate HTML report
pnpm --filter @dagents/console exec playwright test --reporter=html
```

The config is at [`../playwright.config.ts`](../playwright.config.ts):
- `fullyParallel: false`, `workers: 1` — serial execution (the suite shares the dev-stack DB).
- `trace: 'retain-on-failure'` locally, `'on-first-retry'` on CI.
- `webServer.reuseExistingServer: true` — attach to an already-running `next dev` instead of booting a second one.

---

## Test Inventory

10 spec files cover 67 user cases. Each file name is prefixed with its module number for sort order.

| File | Module | UC Range | Active | Fixme | Total |
|------|--------|----------|--------|-------|-------|
| [`01-chat-home.spec.ts`](01-chat-home.spec.ts) | Chat Home (`/`) | UC-CHAT-01~06 | 5 | 2 | 7 |
| [`02-chat-detail.spec.ts`](02-chat-detail.spec.ts) | Chat Detail (`/chats/{id}`) | UC-CHAT-07~13 | 5 | 7 | 12 |
| [`03-directories.spec.ts`](03-directories.spec.ts) | Directories (`/directories`) | UC-DIR-01~05 | 5 | 1 | 6 |
| [`04-agents.spec.ts`](04-agents.spec.ts) | Agents (`/agents`, `/agents/{id}`) | UC-AGT-01~04 | 3 | 2 | 5 |
| [`05-agentflows.spec.ts`](05-agentflows.spec.ts) | AgentFlows (`/flows`, `/flows/{id}/edit`) | UC-FLW-01~07 | 4 | 5 | 9 |
| [`06-daemons.spec.ts`](06-daemons.spec.ts) | Daemons (`/daemons`) | UC-DAE-01~06 | 0 | 6 | 6 |
| [`07-settings.spec.ts`](07-settings.spec.ts) | Settings (`/settings`) | UC-SET-01~06 | 6 | 0 | 6 |
| [`08-sidebar-nav.spec.ts`](08-sidebar-nav.spec.ts) | Sidebar navigation | UC-NAV-01~08 | 7 | 2 | 9 |
| [`09-chat-trigger.spec.ts`](09-chat-trigger.spec.ts) | Chat trigger (@ commands, SSE) | UC-TRG-01~06 | 1 | 6 | 7 |
| [`10-workflow-engine.spec.ts`](10-workflow-engine.spec.ts) | Workflow engine (arch §9) | UC-WF-01~12 | 0 | 12 | 12 |
| [`11-workflow-execution.spec.ts`](11-workflow-execution.spec.ts) | 工作流执行契约（Tier A：WF/OB） | WF-01~08, OB-01~06 | 14 | 0 | 14 |
| [`12-multi-agent.spec.ts`](12-multi-agent.spec.ts) | 多 Agent 协作专项（核心） | MA-01~18 + 冒烟锚 | 19 | 0 | 19 |
| [`13-chat-flow-trigger.spec.ts`](13-chat-flow-trigger.spec.ts) | 聊天触发 / SSE（Tier B） | TR-01~08 | 8 | 0 | 8 |
| [`14-workflow-edge.spec.ts`](14-workflow-edge.spec.ts) | 失败与边界（Tier D） | ED-01~07 + CLI-SMOKE | 7 | 2 | 9 |
| [`15-flows-ui-journey.spec.ts`](15-flows-ui-journey.spec.ts) | 浏览器 UI 旅程（Tier C） | UI-01/02/04/05/08 | 5 | 0 | 5 |
| **Total** | | | **~92 active** | ~45 | ~137 |

> **Note:** Two pre-existing specs (`v0.3-design.spec.ts`, `viewport-matrix.spec.ts`) cover the older v0.3 design-fidelity scenarios and are not part of the 67-UC matrix. They remain in this directory for continuity.

### Status legend

- **Active** = `test(...)` — assertions run against the current implementation. Should pass on a healthy dev stack.
- **Fixme** = `test.fixme(...)` — the feature is unimplemented (or partially implemented). The body drafts the expected assertions so activation is mechanical when the feature lands. Fixme tests are skipped by Playwright and reported as "skipped" in the output.

---

## Writing a New Test

### 1. Identify the UC

Find the user case in `docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md`. Note its UC-ID (e.g. `UC-CHAT-09`) and status (✅ / ⚠️ / ❌).

### 2. Pick the file

Add to the spec file whose UC range covers your case. Use the table above. If the case belongs to a new module, create a new numbered file.

### 3. Follow the pattern

```typescript
import { test, expect } from '@playwright/test'
import { createSeedContext, seedDirectory, seedChat } from './helpers/seed'

test.describe('Module name (UC-XXX-NN ~ MM)', () => {
  let ctx: Awaited<ReturnType<typeof createSeedContext>>
  let chatId: string

  test.beforeAll(async ({ request }) => {
    ctx = await createSeedContext()
    const dirId = await seedDirectory(ctx, { name: 'My test dir' })
    chatId = await seedChat(ctx, { directoryId: dirId, title: 'My test chat' })
  })

  test.afterAll(async () => {
    await ctx?.dispose()
  })

  test('UC-XXX-NN: short description', async ({ page }) => {
    await page.goto(`/chats/${chatId}`)
    await expect(page.getByRole('heading', { name: 'My test chat' })).toBeVisible()
  })

  // For unimplemented features:
  test.fixme('UC-XXX-MM: unimplemented thing', async ({ page }) => {
    // Gap: explain what's missing and why (reference gap-analysis §N)
    // Draft the expected assertions so activation is mechanical.
    await page.goto('/')
    await expect(page.locator('.some-future-selector')).toBeVisible()
  })
})
```

### 4. Selector strategy

Prefer semantic locators in this order:

1. `getByRole('button' | 'tab' | 'heading' | 'link' | 'alertdialog', { name: ... })` — survives CSS refactors.
2. `getByLabel('visible label')` — for inputs with associated labels.
3. `getByPlaceholder('...')` — for inputs without labels.
4. `getByText('visible text')` — for non-interactive text content.
5. `page.locator('.css-class')` — last resort, for elements without good ARIA. Verify the class exists by reading the component source first.

### 5. Verify

```bash
# Typecheck
pnpm --filter @dagents/console exec tsc --noEmit

# Run your new test
pnpm --filter @dagents/console exec playwright test tests/e2e/your-file.spec.ts
```

---

## Seed/Cleanup Helpers

All shared seed/cleanup logic lives in [`helpers/seed.ts`](helpers/seed.ts);
DAG 构造辅助（`node`/`edge`/`linearFlow`/`parallelFlow` + 各节点类型快捷构造，
平铺 `data.<field>` 形态）在 [`helpers/flow-builder.ts`](helpers/flow-builder.ts)。

### API

| Function | Returns | Purpose |
|----------|---------|---------|
| `createSeedContext()` | `SeedContext` | Initialize `@dagents/db`, return a context tracking seeded IDs |
| `seedDirectory(ctx, opts?)` | `directoryId: string` | Insert a `directories` row |
| `seedChat(ctx, opts)` | `chatId: string` | Insert a `chats` row (bind `agentId`/`flowId` to exercise routing) |
| `seedMessage(ctx, opts)` | `messageId: string` | Insert a `chat_messages` row (any role) |
| `seedAgent(ctx, request, opts?)` | `{ agentId, daemonId }` | Register a daemon via dispatch API + insert `agent_daemons` row |
| `seedMockLlmProvider(ctx)` | `providerId` | 把 active LLM provider 切到本地 mock（4010），dispose 恢复 |
| `seedFlow(ctx, request, opts)` | `flowId` | 经 `POST /api/workflows` 建 flow（真实创建路径） |
| `seedPlatformAgent(ctx, opts)` | `agentId` | 直接插 `agents` 行（PlatformAgent 节点的 fetcher 数据源） |
| `seedChatBoundToFlow(ctx, opts)` | `chatId` | 建 chat 并绑定 flow_id（聊天触发 SSE 用） |
| `setMockLlmScript(script)` / `resetMockLlm()` / `mockLlmCalls()` | — | Mock LLM 的编排/取证三件套 |
| `ctx.dispose()` | `Promise<void>` | Delete all seeded rows in FK-safe order |

### Design notes

- **Dynamic import of `@dagents/db`:** `@dagents/db` is not a declared console dependency (the console app itself never touches the DB layer — only the gateway does). The helpers dynamically import it inside `createSeedContext()` so the console's build graph stays clean. This mirrors the pattern in `v0.3-design.spec.ts`.
- **`POSTGRES_URL` must be set before the dynamic import:** `AppDataSource` captures the env at module-construction time. `createSeedContext()` sets it on `process.env` *before* `await import('@dagents/db')`.
- **Cleanup is idempotent:** `dispose()` uses `DELETE ... WHERE id = ANY($1::uuid[])` on each tracked ID array. Empty arrays are skipped. Safe to call multiple times.
- **FK-safe order:** messages → chats → directories; agent_daemons → daemons.

### When to seed via API vs. DB

- **Via API (`seedAgent` registers daemon via `POST /daemons/register`):** when the seed exercises a real production path that the test depends on.
- **Via DB (`seedDirectory`/`seedChat`/`seedMessage` use `runQuery` directly):** when no API exists for the row, or when the test needs exact field values the API would not accept. The gap analysis notes where create-agent API is missing — `seedAgent`'s DB insert has a `TODO` to swap for an API call when it lands.

---

## Strategy: `test.fixme` for Unimplemented Features

The gap analysis identifies **22 fully unimplemented** and **22 partially implemented** user cases out of 67. Rather than skip these, the suite uses `test.fixme(...)` with:

1. **A comment explaining the gap** — references the gap-analysis section and the specific missing piece.
2. **A drafted body** with the expected selectors and assertions — so when the feature lands, removing `.fixme` activates a real test mechanically.

### Why `test.fixme` (not `test.skip`)

- `test.fixme` reports as "skipped" in the output but is **visible in the test file** — a future implementer sees the draft and knows what to assert.
- `test.skip` is conditional and easy to miss; `test.fixme` is unconditional and loud in the report.
- Playwright's `--forbid-only` + CI config doesn't fail on `fixme`, so the suite stays green.

### When to activate a fixme

When the feature lands:

1. Read the fixme body and the gap-analysis row it references.
2. Verify the drafted selectors still match the new implementation (read the component source).
3. Remove `.fixme` — the body becomes a real `test(...)`.
4. Run the test against the dev stack to confirm it passes.

### Known stale gap-analysis notes

During spec writing, several subagents found that the gap analysis (written 2026-07-25) was **already stale** for a few cases — the code had advanced beyond what the analysis recorded. The specs handle this by writing **real `test()` for the working part** and a `test.fixme` only for the genuinely missing piece, with a comment noting the gap-analysis note is outdated. Known stale notes:

- **UC-CHAT-02** (top directory selector): gap-analysis says "NO top selector UI"; `chat-home.tsx` now renders a functional `<DirectorySelector>`.
- **UC-CHAT-03** (suggestion cards): gap-analysis says "ALL only call onPick"; `suggestion-cards.tsx` now has 2 `<Link>` cards navigating to `/flows` and `/agents`.
- **UC-NAV-05** (chat status dot): gap-analysis says "only dot, no message count + status text"; `chat-nav-sidebar.tsx` now renders `.chat-nav-chat-item-count` and `.chat-nav-chat-item-status`.
- **UC-NAV-08** (search): gap-analysis says "only New Chat button"; `chat-nav-sidebar.tsx` now renders `.chat-nav-search-input` with title-based filtering.
- **UC-TRG-02/03/04** (@ commands): gap-analysis says "no parsing logic"; `chat-execute.ts` now has `parseCommand()` + `routeCommand()`, but the routing does not actually call scheduler/dispatch — the gap is now "execution not wired", not "parsing missing".

When you activate any of these fixmes, **update the gap-analysis doc** to reflect the current state.

---

## Debugging

### Trace viewer

Failed local runs write a trace (config: `trace: 'retain-on-failure'`):

```bash
pnpm --filter @dagents/console exec playwright show-trace test-results/<spec>/.playwright-traces/trace.zip
```

### Screenshots

Failed tests automatically capture a screenshot. Find it under `test-results/<spec>/test-failed-1.png`.

### Console logs

```typescript
test('debug a page', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER:', msg.text()))
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message))
  await page.goto('/')
})
```

### Slow motion

```bash
pnpm --filter @dagents/console exec playwright test --headed --workers=1
```

### Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `net::ERR_CONNECTION_REFUSED` on `/api/*` | Gateway (:8080) not running | `pnpm --filter @dagents/gateway dev &` |
| `ECONNREFUSED 127.0.0.1:15432` | Postgres not up | `cd infra && docker compose up -d postgres` |
| `agent_daemons insert did not RETURNING an id` | Dispatch 路由（gateway 内）挂了，daemon 注册静默失败 | Check gateway logs, restart |
| 401 on `/api/*` | SSO gated on dev stack | Run against an SSO-gated-off stack |
| 502/503 on `/api/flows/*` | Gateway 的 workflow 执行入口异常 | Check gateway logs（引擎已内聚在 gateway，无独立服务） |
| Timeout on `goto('/')` | Console dev server failed to boot | Check `next dev` logs; try `E2E_PORT=3001` to avoid :3000 conflicts |

---

## Maintenance

### When the gap analysis changes

The gap analysis at `docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md` is the **source of truth** for UC definitions. When it's updated:

1. **UC status changes (⚠️ → ✅):** find the corresponding `test.fixme` in the spec file, remove `.fixme`, verify the body assertions still match the implementation, run the test.
2. **New UC added:** add a new `test(...)` or `test.fixme(...)` to the relevant spec file. Update the Test Inventory table in this README.
3. **UC removed:** delete the corresponding test. Update the Test Inventory table.

### When selectors change

The specs prefer semantic locators (`getByRole`, `getByLabel`) precisely because CSS class names change. When a component refactor breaks a CSS-class selector:

1. Read the new component source.
2. Update the selector to a semantic locator if possible, or to the new class name.
3. Run the affected spec to confirm.

### When the dev stack changes

If the docker-compose port mappings change (e.g. Postgres moves from :15432 to :5432), update:

1. `helpers/seed.ts` — `E2E_POSTGRES_URL` default.
2. This README — Prerequisites table.
3. `playwright.config.ts` — if the console port changes.

### Adding a new module

1. Create `NN-module-name.spec.ts` with the next number.
2. Add the file header docblock (module, UC range, status, prerequisites).
3. Add `beforeAll`/`afterAll` with seed/cleanup.
4. Write one `test()` or `test.fixme()` per UC.
5. Update the Test Inventory table in this README.
6. Run `pnpm --filter @dagents/console exec tsc --noEmit` to verify.

### Relationship to other test suites

| Suite | Location | Scope | When to use |
|-------|----------|-------|-------------|
| **Playwright user-case e2e** (this) | `apps/console/tests/e2e/` | Browser-driven UI + HTTP contract | Verifying user-visible behavior per UC |
| Console unit tests | `apps/console/src/**/__tests__/` | vitest, isolated component/lib tests | Verifying component logic in isolation |
| Gateway route tests | `apps/gateway/src/__tests__/` | vitest + `app.request()` | Verifying gateway HTTP contract |

The Playwright suite is the **top of the testing pyramid** — it should remain small and focused on user cases. Push detailed assertions down to the unit suites when a Playwright test grows beyond ~50 lines of assertions.
