# Show HN 帖（可直接粘贴）

## 标题（三选一，推荐 1）

1. `Show HN: Dagents – Orchestrate your local Claude Code and Codex CLIs into parallel teams`
2. `Show HN: Dagents – A local-first control tower for your CLI coding agents`
3. `Show HN: Dagents – Visual DAG workflows on top of claude/codex CLIs, no API key needed`

> HN 标题不可改，选 1：同时点到两个最热的搜索词（Claude Code、Codex）+ 结果（parallel teams）。

## 正文

Hi HN — I've been building Dagents, an open-source, self-hosted workbench that
orchestrates the CLI coding agents you already have installed (`claude`,
`codex`, `qwen`, 14 more) into parallel teams on a visual DAG canvas.

The itch: every CLI agent is an island. Claude Code has its own multi-agent
mode, Codex has its own, and the cloud orchestrators (Dify, n8n, Flowise)
assume you'll hand them API keys and run your prompts on their backend. I
wanted the opposite: my agents, my machine, my Postgres, nothing phoning home.

What it does:

- **CLI-first execution.** The baseline engine spawns your local CLIs. No LLM
  provider configured? Everything still runs. Configure one and it becomes an
  optional fast path. Workflows are durable, shareable JSON — not session state.
- **A DAG canvas you can actually watch.** 14 node types, parallel waves,
  condition routing, loops, human-in-the-loop. While a run executes, node
  badges flip live, edges light up, and each node streams its output into a
  results panel. Every run gets a spectator URL you can reopen later.
- **Chat copilot.** `@workflow <one line>` compiles a prompt into a flow;
  `@agent-name` dispatches a persona with its skills. The copilot floats on
  every page.
- **Persona library.** Mount any agency-agents-style library (270+ expert
  personas) from the filesystem; enable on demand, sync upstream with drift
  detection. Team templates spin up ready-made multi-agent flows (product
  discovery, landing-page sprint, org-wide parallel discovery...).
- **Local-first.** Postgres on your machine, localhost-only by default, no
  accounts, no telemetry, API keys encrypted at rest (AES-256-GCM). Bilingual
  UI (EN/中文).

Stack: TypeScript monorepo — Next.js console, Hono gateway, a DAG engine in
`packages/workflow`, pull-based daemon for remote execution. The canvas is
vendored from Flowise's agentflow (Apache-2.0, frontend-only). Apache-2.0
overall. 547 e2e cases run on a mock-LLM harness in CI.

Known limitations, stated up front: JS nodes run via `new Function` (not
sandboxed — flows are authored by the machine owner), remote-daemon tasks
aren't cancellable yet, and the Retriever node is keyword-based, not vector
RAG. Full list in the README.

Quick start (Docker, migrations run themselves):

    git clone https://github.com/dagents/dagents.git && cd dagents
    docker compose pull dagents && docker compose up
    # http://localhost:3000 — with a `claude` CLI on PATH, it's usable with zero config

A 17-second clip of a 5-node run (three analysts in parallel → synthesis) is
in the README — recorded with a scripted provider for pacing, but the engine,
canvas and streaming are the real app.

I'd genuinely like feedback on two things: (1) does the CLI-first baseline
match how you'd actually use this — is "no API key to start" the right wedge,
or would you only ever use it with a provider configured? (2) the persona
library mounts from the filesystem instead of a DB — convenient for git-synced
libraries, but I'm unsure how foreign that feels.

---

## 发帖备注（不进正文）

- HN 正文支持有限 HTML；上面的 markdown 需手工微调（`**bold**` → `<b>`，代码块用缩进）
- 结尾两个问题是故意的：Show HN 帖带具体问题，评论区存活率高很多
- 账号需有 karma 历史；纯新号发 Show HN 会被怀疑，可先在评论区活跃几天
- 发帖后**不要**自己顶帖、不要贴 Reddit 链接互推（HN 反感）；可以发到 Show HN 周帖之外的相关帖子里 ONLY 在有人问类似工具时
