<div align="center">

# Dagents

**A chat-first platform for orchestrating heterogeneous coding agents — on your own machine, against your own LLM providers.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)
[![CI](https://github.com/dagents/dagents/actions/workflows/ci.yml/badge.svg)](https://github.com/dagents/dagents/actions/workflows/ci.yml)

Chat with `claude`, `codex`, and 15+ other CLI agents from one place · compose them into visual workflows · zero-config to start, everything stays local.

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

## Why Dagents

Most agent platforms want to be the backend. Dagents is the opposite: **your local CLI agents are the baseline execution engine**, and everything else is optional acceleration.

- **CLI-first execution** — Workflows and chat run by spawning your local CLI agents (`claude`, `codex`, `gemini`, `qwen`, … — 17 adapters). HTTP LLM providers are an optional fast path, not a dependency. No provider configured? It still runs.
- **Chat-first UX** — A single chat home (`/`) + chat detail pages. Type `@workflow …` to compile a multi-agent workflow from a prompt; mention agents by name and they get dispatched with their persona and skills.
- **Visual workflow canvas** — A 14-node DAG engine with parallel waves, condition routing, loops, human-in-the-loop, and SSE streaming, edited on a React Flow canvas (`/workflows/[id]/canvas`).
- **Agent personality library** — Mount any [agency-agents](https://github.com/msitarzewski/agency-agents)-style library (270+ expert personas) from the filesystem; enable personas on demand, sync upstream with drift detection. No bloat — only enabled agents live in the database.
- **Flow template center** — Built-in templates, team-scenario templates, and "save canvas as template". Instantiating re-binds personas by name; missing ones degrade to plain LLM nodes so templates always run.
- **Local-first & private** — Postgres on your machine, no telemetry, no accounts, no callbacks home. LLM API keys encrypted at rest (AES-256-GCM).
- **Bilingual UI** — Chinese and English, switchable in the sidebar.

## Architecture

```
console (Next.js :3000) → gateway (Hono :8080) → @dagents/workflow engine
                                              → [dispatch routes inline] → local daemon → CLI agents
```

| Piece | Where | Notes |
|---|---|---|
| Console | `apps/console` | Next.js App Router, every backend call goes through the gateway |
| Gateway | `apps/gateway` | Hono. SSO/auth, workflow CRUD + runs, dispatch protocol, LLM provider CRUD + proxying |
| Workflow engine | `packages/workflow` | 14 nodes, DAG executor, SSE streaming, variable resolution |
| CLI adapters | `packages/agent-adapters` | claude / codex / qwen / copilot / opencode / codebuddy / cursor / deveco / antigravity / openclaw / pi / hermes / kimi / kiro / grok / qoder / traecli |
| Daemon | `packages/daemon` | Pull-based (`register → heartbeat → claim → execute`) for remote execution; inline execution is the default path |
| Canvas | `vendor/agentflow` | Vendored from [Flowise](https://github.com/FlowiseAI/Flowise) (Apache-2.0), frontend-only |

Dependency direction is acyclic: `contracts ← {agent-adapters, daemon, db} ← gateway`; `workflow ← gateway`.

## Quick start

### Full stack via Docker

```bash
git clone https://github.com/dagents/dagents.git
cd dagents
docker compose up        # Postgres + gateway + console
```

Open http://localhost:3000 — migrations run automatically on boot. Everything
binds to `127.0.0.1` only. The compose file pairs
`image: ghcr.io/dagents/dagents:latest` with `build: .`: run
`docker compose pull dagents` first to fetch the prebuilt multi-arch image and
skip the local build, which otherwise takes a few minutes.

### Dev mode

```bash
pnpm install                       # .npmrc sets ignore-scripts=true (vendored canvas has no husky)
cd infra && docker compose up -d   # Postgres :15432 + Langfuse :3001
pnpm --filter @dagents/db migration:run
pnpm --filter @dagents/gateway dev          # :8080
pnpm --filter @dagents/console dev          # :3000
pnpm dev:daemon                             # optional, for remote agents
```

Prerequisites: Node ≥ 22, pnpm 10 (`corepack enable`), Docker. With a
`claude` CLI on your PATH, the chat home is fully functional with zero further
configuration — that's the CLI-first baseline.

| Service | Port | Notes |
|---|---|---|
| Gateway | 8080 | binds `127.0.0.1` by default |
| Console | 3000 | |
| Postgres | host **15432** → 5432 | remapped to avoid host collisions |
| Langfuse | 3001 | optional observability profile |

## Security — read before exposing the gateway

By default everything listens on localhost only. If you plan to put the
gateway behind a reverse proxy or on a network, configure authentication first:

| Variable | Purpose | Generate with |
|---|---|---|
| `GATEWAY_API_KEY` | Bearer auth for API routes | `openssl rand -hex 32` |
| `DAEMON_REGISTER_TOKEN` | Daemon registration | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | AES-256-GCM for stored LLM API keys | `openssl rand -hex 32` |
| `SSO_SESSION_SECRET` | SSO session signing | `openssl rand -base64 48` |

Without `ENCRYPTION_KEY`, LLM API keys are stored Base64-reversible and the
gateway logs a warning. Full details and an SSO option in the docs.

## Known limitations (honest list)

We'd rather tell you up front:

- **JS nodes are not sandboxed** — `CustomFunction` / tool / loop conditions run via `new Function`. Flows are authored by the machine owner; do not expose flow authoring to untrusted users.
- **LLM fetches have no timeout/cancellation** — a hung upstream provider stalls the run (HTTP nodes do have a 15s timeout + 32KB truncation).
- **Plain `LLM` nodes are single-shot** — use `PlatformAgent` nodes when you need tool-calling loops.
- **Retriever is keyword-based** (ILIKE over chat history), not vector RAG — the node contract is ready for a vector backend swap.
- **Human-input pending state is in-memory** — a gateway restart drops pending inputs (they fail with timeout).
- Several CLI adapters (codex / codebuddy / copilot / qwen) are implemented from official docs and not yet regression-tested against real CLIs.

Full trade-off list with upgrade paths: `docs/workflow-engine.md` § 现状与限制.

## Documentation

The doc map lives in [`docs/README.md`](./docs/README.md). Highlights:

- [`docs/workflow-engine.md`](./docs/workflow-engine.md) — engine architecture, execution model, Langfuse setup
- [`docs/skills-registry.md`](./docs/skills-registry.md) — skill discovery and system-prompt injection
- [`docs/agent-library.md`](./docs/agent-library.md) — personality library mounting, drift sync, team templates
- [`docs/flow-templates.md`](./docs/flow-templates.md) — the three-layer template center
- [`docs/e2e-test-plan.md`](./docs/e2e-test-plan.md) — execution-state e2e suite and the mock LLM harness
- [`CLAUDE.md`](./CLAUDE.md) · [`AGENTS.md`](./AGENTS.md) — working agreements for AI coding agents (and humans)

## Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, testing, and
conventions (Chinese version: [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)).
By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).
Security reports follow [SECURITY.md](./SECURITY.md) — private disclosure,
acknowledged within 7 working days.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

The workflow canvas in `vendor/agentflow/` is vendored from
[FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) `packages/agentflow`
(Apache-2.0); see `vendor/agentflow/NOTICE`.
