# Changelog

All notable changes to Dagents are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-08-20

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
