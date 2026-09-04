# Reddit 三连帖（各 sub 版规不同，发前先读 sidebar）

## 1. r/LocalLLaMA（本地优先钩子）

**标题（二选一）：**
- `Dagents (open-source, self-hosted): your local CLI agents are the LLM backend — visual DAG orchestration, zero API keys to start`
- `I built a local-first orchestration canvas for claude/codex/qwen CLIs — no cloud, no keys, everything in your Postgres`

**正文：**

Hey r/LocalLLaMA —

Most agent orchestrators assume you'll hand them API keys and run everything
through their backend. I built the opposite: Dagents treats the CLI agents
already on your machine (`claude`, `codex`, `qwen`, 14 community adapters) as
the baseline execution engine. No provider configured? Workflows still run.
Configure an OpenAI-compatible endpoint (any local server, llama.cpp,
vLLM, LM Studio...) and it becomes the fast path automatically.

- 14-node DAG canvas: parallel waves, conditions, loops, human-in-the-loop
- Live execution view: node badges, edges lighting up, per-node streaming output
- Chat copilot: `@workflow <one line>` compiles a prompt into a flow
- Persona library mounted from the filesystem (270+ personas, git-syncable)
- Postgres on your machine, localhost-only binding, no telemetry, keys encrypted (AES-256-GCM)
- Bilingual UI (EN/中文)

Demo clip (25s, a real local `claude` CLI run compressed from ~2 min):
https://github.com/dagents/dagents#readme

Docker quick start:
```
git clone https://github.com/dagents/dagents.git && cd dagents
docker compose pull dagents && docker compose up   # http://localhost:3000
```

Honest limitations: JS nodes aren't sandboxed (flows are authored by the
machine owner), remote-daemon tasks can't be cancelled yet, retriever is
keyword-based. Full list in README.

Apache-2.0, TypeScript monorepo (Next.js + Hono + DAG engine), 547 e2e cases
in CI with a mock-LLM harness.

What would it take for you to actually run this locally? Which CLI agents are
on your PATH today?

---

## 2. r/selfhosted（自托管钩子）

**标题：** `Dagents — self-hosted workflow canvas that turns your CLI coding agents (claude/codex) into parallel teams; localhost-only by default, your Postgres, no telemetry`

**正文：**

Sharing a self-hostable project: Dagents orchestrates CLI coding agents into
parallel teams on a visual DAG canvas.

Self-hosting notes for this crowd:

- `docker compose up` — Postgres + gateway + console, migrations run on boot
- Everything binds to 127.0.0.1 by default; exposing it is opt-in with bearer
  auth (GATEWAY_API_KEY), daemon registration tokens, AES-256-GCM key
  encryption at rest, and an SSO option
- No accounts, no telemetry, no callbacks home
- Apache-2.0, the canvas component is vendored from Flowise (also Apache-2.0,
  frontend-only, NOTICE included)

The angle: your locally installed `claude` / `codex` CLIs are the execution
engine — you don't need any LLM API key to start, though OpenAI-compatible
providers (including local servers) are supported as an optional fast path.

Repo + 17s demo clip: https://github.com/dagents/dagents

If you try it: the thing I'd most like feedback on is the first-run experience
(docker compose up → localhost:3000). What confused you in the first 5 minutes?

---

## 3. r/ClaudeAI（Claude Code 用户钩子）

**标题：** `Open-source canvas to run multiple Claude Code instances in parallel and merge their outputs (local, self-hosted)`

**正文：**

If you're running Claude Code in one terminal at a time, this might be for
you: Dagents (open-source, self-hosted) spawns multiple `claude` CLI instances
in parallel and wires them into visual DAG workflows — e.g. three analysts fan
out on a brief, stream their outputs live, then a synthesis node merges into
one verdict.

- Runs the real `claude` CLI on your machine (also codex/qwen + 14 adapters)
- Parallel waves, condition routing, loops, human-in-the-loop on the canvas
- Live per-node streaming + a spectator link for every run
- Persona library: mount agency-agents-style libraries, enable personas
  (PM, QA, architect...) as real Claude Code agents with their own prompts
- Team templates: one click → ready-made multi-agent flows
- No API key needed to start; works alongside your Claude subscription CLI

Repo + 17s clip: https://github.com/dagents/dagents

It's Apache-2.0, TypeScript, Docker quick start in the README. Not affiliated
with Anthropic — this is a hobby infrastructure project that treats CLI agents
as the engine.

What multi-agent patterns are you manually orchestrating today (tmux panes?
separate terminals?) that you'd want on a canvas?

---

## 发帖备注

- 三个 sub 同一周内**不要同一天发**；HN 出结果后再决定节奏
- r/ClaudeAI 对自我推广敏感：若账号历史几乎没有评论互动，先参与几天再发
- r/selfhosted 需要 flair（selfhosted software / open source）；发帖界面选好
- 每帖结尾都留了具体问题 —— Reddit 算法看重评论率，纯广播帖会沉
- 若有人指出 bug：当场承认 + 开 issue + 修 —— 差评变好评的最高性价比路径
