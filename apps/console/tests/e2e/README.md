# Chat-First E2E Test Harness

> **Scope:** Playwright browser e2e for the Chat-First user-facing surface.
> **Coverage:** 67 user cases from `docs/superpowers/specs/2026-07-25-user-cases-gap-analysis.md`, organized into 10 modules.
> **Status:** 36 active tests + 43 `test.fixme` placeholders for unimplemented features.

This directory holds the **user-case e2e suite** — true end-to-end tests that drive a real browser through the Chat-First UI. They assert what the user sees and what the HTTP contract returns, not internal code behavior. Each test maps to a numbered user case (UC-ID) in the gap analysis.

For the in-process backend e2e (gateway → dispatch → scheduler → daemon → LLM closed loop), see `packages/e2e/` instead — that suite uses vitest + `app.request()` and does not render the UI.

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
# 1. Bring up the dev stack (Postgres, Redis, gateway, dispatch, workflow engine)
docker compose up -d
pnpm --filter @dagents/gateway dev &
pnpm --filter @dagents/dispatch dev &
# (workflow engine — only needed for /flows and prediction paths)

# 2. Run the full e2e suite (boots Next dev on :3000 automatically)
pnpm --filter @dagents/console test:e2e

# 3. Or run a single module
pnpm --filter @dagents/console exec playwright test tests/e2e/03-directories.spec.ts
```

---

## Prerequisites

The e2e suite needs the **full dagents dev stack** up:

| Service | Port | Why |
|---------|------|-----|
| Postgres | `:15432` | directories / chats / chat_messages / runs / agent_daemons tables |
| Redis | `:16479` | dispatch task queue, WS hub |
| Gateway | `:8080` | `/api/v1/chats/*`, `/api/v1/directories/*`, `/api/v1/dispatch/*` |
| Dispatch | `:8081` | `/daemons/register` (seed helper registers a daemon host) |
| Scheduler | (optional) | Only needed for `@flow` fanout tests (currently all `fixme`) |
| Workflow Engine | — | `/flows` browse + `/workflows/:id/canvas` canvas + prediction SSE (current proxy paths) |
| Console (Next) | `:3000` | Auto-booted by Playwright's `webServer` config — no need to start manually |

### Environment variables

| Var | Default | When to override |
|-----|---------|------------------|
| `POSTGRES_URL` | `postgresql://dagents:dagents_dev@localhost:15432/dagents` | Pointing at a non-default stack |
| `E2E_GATEWAY_URL` | `http://localhost:8080` | Gateway on a different port |
| `E2E_PORT` | `3000` | Console on a different port (avoids conflicts with another Next app on :3000) |

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
| **Total** | | | **36** | **43** | **79** |

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

All shared seed/cleanup logic lives in [`helpers/seed.ts`](helpers/seed.ts).

### API

| Function | Returns | Purpose |
|----------|---------|---------|
| `createSeedContext()` | `SeedContext` | Initialize `@dagents/db`, return a context tracking seeded IDs |
| `seedDirectory(ctx, opts?)` | `directoryId: string` | Insert a `directories` row |
| `seedChat(ctx, opts)` | `chatId: string` | Insert a `chats` row (bind `agentId`/`flowId` to exercise routing) |
| `seedMessage(ctx, opts)` | `messageId: string` | Insert a `chat_messages` row (any role) |
| `seedAgent(ctx, request, opts?)` | `{ agentId, daemonId }` | Register a daemon via dispatch API + insert `agent_daemons` row |
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
| `net::ERR_CONNECTION_REFUSED` on `/api/*` | Gateway (:8080) or dispatch (:8081) not running | `pnpm --filter @dagents/gateway dev &` etc. |
| `ECONNREFUSED 127.0.0.1:15432` | Postgres not up | `docker compose up -d postgres` |
| `agent_daemons insert did not RETURNING an id` | Dispatch API down (daemon register failed silently) | Check dispatch logs, restart |
| 401 on `/api/*` | SSO gated on dev stack | Run against an SSO-gated-off stack |
| 502/503 on `/api/flows/*` | Workflow engine not running | Start the workflow engine — only needed for `/flows` specs |
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
| Backend closed-loop e2e | `packages/e2e/` | vitest + `app.request()`, full gateway→dispatch→scheduler→daemon chain | Verifying backend integration without UI |
| Console unit tests | `apps/console/src/**/__tests__/` | vitest, isolated component/lib tests | Verifying component logic in isolation |
| Gateway route tests | `apps/gateway/src/__tests__/` | vitest + `app.request()` | Verifying gateway HTTP contract |

The Playwright suite is the **top of the testing pyramid** — it should remain small and focused on user cases. Push detailed assertions down to the unit suites when a Playwright test grows beyond ~50 lines of assertions.
