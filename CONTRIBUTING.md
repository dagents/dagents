# Contributing to Dagents

Thanks for your interest in contributing! This guide takes you from a fresh
clone to a running dev stack and your first PR. It assumes zero prior
knowledge of the codebase.

**[简体中文](./CONTRIBUTING.zh-CN.md) · English**

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **≥ 22** | Check with `node -v`. Some CLI agents (openclaw) need recent 22.x patches. |
| pnpm | 10.x | `corepack enable` picks up the version pinned in `package.json` (`packageManager`). |
| Docker | any recent | Runs the Postgres (+ optional Langfuse) dev stack. |
| Git | any | |

At least one coding-agent CLI on your `PATH` (e.g. [`claude`](https://docs.anthropic.com/en/docs/claude-code)) is
recommended for end-to-end runs, but it is not required for most tests.

## Getting the code

```bash
git clone https://github.com/dagents/dagents.git
cd dagents
pnpm install
```

> `.npmrc` sets `ignore-scripts=true` — this is intentional. The vendored
> `vendor/agentflow` package has a `husky install` postinstall that would fail
> (it has no `.git`); scripts are skipped globally.

## Boot the dev stack

```bash
# 1. Postgres (:15432) + Langfuse (:3001, optional profile)
cd infra && docker compose up -d && cd ..

# 2. Env (defaults match the infra stack — usually no edits needed)
cp .env.example .env

# 3. Apply database migrations
pnpm --filter @dagents/db migration:run

# 4. Gateway (:8080)
pnpm --filter @dagents/gateway dev

# 5. Console (:3000) — in a second terminal
pnpm --filter @dagents/console dev
```

Open http://localhost:3000. To also run the daemon (only needed for `remote`
agents — inline execution is the default path):

```bash
pnpm dev:daemon
```

### Full stack via Docker (no dev servers)

```bash
docker compose up
# → builds the monorepo, waits for Postgres, runs migrations,
#   boots gateway + console. Open http://localhost:3000
```

## Everyday commands

```bash
pnpm build          # turbo build (tsup → dist/, next build for console)
pnpm test           # vitest run, per package
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint (vendored agentflow excluded)

# Single test file / single test
pnpm --filter @dagents/gateway exec vitest run src/__tests__/cli-first.test.ts
pnpm --filter @dagents/gateway exec vitest run -t "degrades to a placeholder"

# DB migrations (TypeORM, packages/db)
pnpm --filter @dagents/db migration:generate   # from entity changes
pnpm --filter @dagents/db migration:revert     # roll back the last
```

## Testing

- **Unit tests** — Vitest, colocated with source (`*.test.ts` or `src/__tests__/`).
  Gateway tests drive the Hono app directly via `app.request()`.
- **DB-backed tests** — several gateway/db suites initialize a real Postgres
  connection (`AppDataSource`). Run the infra stack first (port 15432), or rely
  on CI which provisions a Postgres service.
- **E2E** — Playwright suites in `apps/console/tests/e2e/` run against a
  **Mock LLM Provider** (OpenAI-compatible fake on :4010) so no real keys are
  needed. See `apps/console/tests/e2e/README.md` and `docs/e2e-test-plan.md`
  for the full harness (dedicated `dagents_e2e` database, `flow-builder`
  helpers).
  - If an e2e run is killed mid-flight, mock provider rows (`e2e-mock-%`) can
    linger in the dev DB and send real LLM calls at a dead mock. Clean up:
    `DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%';`

We follow TDD for feature work: failing test → minimal implementation →
commit. Every task lands with its test.

## Repository layout

```
apps/console        Next.js App Router UI (chat-first, bilingual zh/en)
apps/gateway        Hono API server (auth, workflows, dispatch, LLM proxy)
packages/contracts  Zero-dependency shared types (agent, protocol) — built first
packages/agent-adapters  17 CLI agent adapters (claude, codex, …)
packages/daemon     Pull-based daemon (register → heartbeat → claim → execute)
packages/db         TypeORM entities + migrations
packages/workflow   In-repo workflow engine (14 nodes, DAG executor, SSE)
packages/shared     OTel, logging, Langfuse client
vendor/agentflow    Vendored Flowise Agentflow canvas (Apache-2.0, see NOTICE)
```

Dependency direction is acyclic and enforced by convention:
`contracts ← {agent-adapters, daemon, db} ← gateway`; `workflow ← gateway`;
`vendor/agentflow ← console`. See `CLAUDE.md` for the full contract.

## Code style & commits

- TypeScript strict mode; match the surrounding style. ESLint warnings
  (`no-unused-vars`, `react-hooks/exhaustive-deps`) are non-blocking by design;
  errors fail CI.
- **Conventional commits**: `feat(scope): …`, `fix(scope): …`, `docs: …`,
  `ci: …` — single line, no attribution trailers.
- UI copy is written in Chinese and wrapped with `t('…')`; add the English
  entry under `apps/console/src/i18n/en/`. Missing translations fall back to
  Chinese automatically. See the i18n notes in `AGENTS.md`.

## Pull requests

1. Fork / branch from `main`.
2. Keep PRs small and focused; reference issues with `Closes #123`.
3. Fill in the PR template (what / why / how tested / risks).
4. New behavior needs tests (happy path + one failure or edge case).
5. Update docs in the same PR when behavior changes — the doc map lives in
   `docs/README.md`, topic docs (`docs/workflow-engine.md`, …) are kept in
   sync with code, never allowed to lag.

For larger features we use a brainstorm → spec → plan pipeline
(`docs/superpowers/`); if you're proposing a significant architectural change,
open a discussion or issue first rather than a surprise PR.

## Gotchas

- **Never run `pnpm build` while the console dev server is running.** The
  production build overwrites `apps/console/.next` and the dev server will 500
  across the site. `pnpm test` via turbo can trigger this too — when in doubt,
  run package-scoped tests (`pnpm --filter <pkg> test`). If you hit it anyway,
  `bash restart-gateway.sh` cleans the `.next` cache and restarts both apps.
- The gateway binds `127.0.0.1` by default — see the security notes in
  `README.md` before exposing it beyond localhost.

## Where to get help

- Open a [Discussion](https://github.com/dagents/dagents/discussions) for questions.
- Open an issue with the bug template for reproducible problems.
