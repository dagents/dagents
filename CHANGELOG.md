# Changelog

All notable changes to Dagents are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-04

Workflow-first, and execution you can watch.

### Changed

- **Workflow-First IA reversal** — `/` is now the Flows workbench (flow cards
  with run history, template gallery entry, one-line generator); chat demoted
  to a global floating copilot (draggable, position memory) present on every
  page. New app navigation (Workflows / Agents / Skills / Daemons +
  project-scoped chat tree). Rollback via `localStorage dagents.ia.workflow-first=off`.
- **One home per run: the canvas** — the old flow detail page is retired;
  starting a run lands on the canvas spectator view (`?run=<id>`), same entry
  as run-history rows and chat execution records. Sidebar template tab and
  standalone `/runs` page removed (history lives in each flow's card).
- **No wall-clock cap on CLI agents** — replaced by an inactivity watchdog
  (default 5 min, reset on every output line); long autonomous runs are the
  norm, a hard 180s cap was truncating real 4-agent parallel runs into false
  successes. Timeouts/cancellations now fail honestly with usage attached.
- List-page runs are async (`?async=1`) with a run-input dialog and
  project-directory selector — the button responds instantly instead of
  blocking for minutes.

### Added

- **Streaming node output** — LLM/Agent nodes stream text as they generate
  (live tail in the run panel, canvas badges flip in real time, edges light
  up); runs are no longer a black box until completion.
- **Activity stream while running** — CLI thinking (💭) and tool calls (🔧)
  surface as a live timeline per node, and are preserved in the final output
  for post-run replay ("dropping it on completion drops how the work was done").
- **Team-scenario templates expanded** — 9 multi-agent templates covering all
  10 documented agency-agents workflows (org-wide parallel discovery 8-way
  fan-out, landing-page sprint, book-chapter drafting…), with first-run input
  guidance (`inputHint`/`inputExample`) on start nodes.
- Template instantiation flow: structural preview in the confirm step,
  parameter defaults visible, per-node instruction audit.
- README demo GIF (17s canvas run) and a `docs/launch/` kit.

### Fixed

- **Engine: N-into-1 merge contract** — `mergeInputs` now concatenates
  `content`; downstream LLM/PlatformAgent nodes previously lost N-1 upstream
  outputs to shallow-merge overwrite (e2e WF-09 regression-pinned).
- **Engine: empty-output guard** — LLM/PlatformAgent nodes with empty bodies
  fail honestly instead of fake-succeeding (WF-10/11).
- Iteration/Loop final-state spans now report true whole-run duration and
  `completedIterations` (six previously failing e2e cases green).
- Gateway test suite isolated to an auto-provisioned `dagents_gw_test`
  database — running tests no longer wipes real run history from the dev DB.
- Canvas UI: run-button hover invisibility, checklist button overlaying
  dialogs, Esc/outside-click closes the run-input panel, MUI dropdown
  key-spread warning.

## [0.1.0] - 2026-08-22

First public release.

### Added

- **Chat-First console** (Next.js) — chat home + detail pages, agents / flows /
  daemons / settings / directories / skills pages, bilingual UI (Chinese +
  English, natural-key i18n with fallback).
- **Gateway** (Hono, :8080) — SSO/API-key auth, chats & chat-execution with
  `@workflow` / `@agent` mentions, workflow CRUD + runs with SSE streaming,
  dispatch protocol routes (daemon register/heartbeat/claim/complete), LLM
  provider CRUD with dynamic AES-256-GCM-encrypted proxying.
- **Workflow engine** (`@dagents/workflow`) — 14 node types, DAG executor with
  parallel waves / condition routing / loops / iteration, variable resolution,
  human-in-the-loop, sub-flow execution, Langfuse trace export.
- **Workflow canvas** — React Flow editor at `/workflows/[id]/canvas`
  (vendored from Flowise Agentflow, Apache-2.0).
- **CLI-first execution** — 17 CLI agent adapters (claude, codex, qwen, copilot,
  opencode, codebuddy, cursor, deveco, antigravity, openclaw, pi, hermes, kimi,
  kiro, grok, qoder, traecli); workflows and chat run with zero LLM-provider
  configuration, HTTP providers optional.
- **Skills registry** — filesystem-based skill discovery (`~/.agents/skills`),
  console-managed roots, system-prompt injection into chat and workflow agents.
- **Agent personality library** — mount agency-agents-style libraries
  (270+ personas), enable-on-demand compilation with slim tiers, upstream drift
  sync + reimport, 6 team-scenario templates.
- **Flow template center** — built-in templates, canvas "save as template",
  personaName re-binding with LLM-node degradation for missing personas.
- **Daemon** (`@dagents/daemon`) — pull-based remote execution loop with
  graceful drain.
- **Observability** — OTel tracing with `run_id` threading end-to-end,
  optional Langfuse v2 profile via `docker compose --profile obs up`.
- **Deployment** — single `docker compose up` full stack (Postgres + gateway +
  console, migrations automatic), localhost-only port binding by default.
- **Testing** — per-package Vitest suites, Playwright e2e against a
  OpenAI-compatible mock LLM provider (55+ execution-state cases).

### Security

- SSRF hardening on the LLM proxy (absolute-URL hijack + key exfiltration
  blocked); `/internal` and dispatch non-protocol routes gated by
  `GATEWAY_API_KEY`; WebSocket upgrades validate token + Origin; HTTP nodes
  enforce scheme allowlist, 15s timeout, 32KB truncation (2026-08-16 audit).

[Unreleased]: https://github.com/dagents/dagents/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dagents/dagents/releases/tag/v0.1.0
