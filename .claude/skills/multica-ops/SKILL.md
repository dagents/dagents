---
name: multica-ops
description: Operate the multica CLI — create/assign/rerun issues, manage autopilots & squads, @-notify agents, run the local daemon. Use whenever the task involves multica (the AI-native task platform at 021multica.zero2x.org): triaging issues, scheduling agent work, coordinating dev/product squads, or driving an autopilot coordinator.
version: 1.0.0
source: cli-help-extraction
last_updated: 2026-07-08
---

# multica Operations Skill

> Practical guide for driving multica from the CLI. Covers the 80% of ops work: issues, agents, squads, autopilots, daemon, and the non-obvious bits (@-notification format, rerun-vs-skip, metadata KV, duplicate detection). Built from `multica --help` walks + production lessons from an existing coordinator autopilot.

## Context

- **Server**: `https://021multica.zero2x.org` (configured via `multica config set server_url ...` or `MULTICA_SERVER_URL`)
- **CLI**: `/usr/local/bin/multica` (v0.3.18+). Check with `multica version`.
- **Auth**: `multica auth status` shows current user + token. `multica login` for browser OAuth (90-day token); `multica login --token <mul_...>` for headless.
- **Config file**: `~/.multica/config.json` (keys: `server_url`, `app_url`, active workspace).
- **Output**: almost every command takes `--output json` (default for most create/update) or `--output table`. **Prefer `--output json` for scripting** — parse with `jq`/`python -c`.

## Core Command Map

```
multica issue     create/list/get/update/assign/status/rerun/comment/metadata/runs/pull-requests/search/label/subscriber/cancel-task
multica agent     create/list/get/update/archive/restore/avatar/env/skills/tasks
multica squad     create/list/get/update/delete/member/activity
multica autopilot create/list/get/update/delete/trigger/trigger-add/trigger-update/trigger-delete/trigger-rotate-url/runs
multica project   (create/list/get/...)
multica daemon    start/stop/restart/status/logs/disk-usage
multica config    set/show
multica auth      status/logout/...
multica label / repo / skill / workspace / attachment / user / runtime
```

## Issue Lifecycle (the main workflow)

### Status state machine

```
backlog → todo → in_progress → in_review → done
                     ↑            │          │
                     └────────────┘          │
                     (REQUEST_CHANGES)       │
                                             │
cancelled ← (any)                            │
blocked ← (any)                              │
```

Valid statuses: `backlog, todo, in_progress, in_review, done, blocked, cancelled`.

### Create an issue

```bash
# Basic
multica issue create --project <PID> --title "[M0.1] 建 monorepo 骨架" --priority high --output json

# With description (multi-line, prefer file to preserve formatting + avoid shell escaping)
cat > /tmp/desc.md <<'EOF'
**目标:** ...
**验收:** ...
EOF
multica issue create --project <PID> --title "..." --description-file /tmp/desc.md --output json

# With assignee (squad or agent, by id or fuzzy name)
multica issue create --project <PID> --title "..." --assignee-id <squad-or-agent-uuid> --priority medium

# As sub-issue (epic parent)
multica issue create --project <PID> --title "..." --parent <parent-issue-id>
```

**Returns**: JSON with `id` (UUID), `identifier` (MZW-xxx, human-readable), `number`. **Use `identifier` for branch names and human chat; use `id` for API calls.**

### Duplicate detection (gotcha)

multica rejects creating an issue with the same title as an active (non-done/cancelled) issue:
```
Active duplicate issue exists: MZW-234 [M0.1] 建 monorepo 骨架 (status: todo).
Set allow_duplicate=true or use --allow-duplicate to create another.
```
- If you genuinely want a dup: `--allow-duplicate`.
- Otherwise: **the duplicate IS your issue** — find it with `multica issue list` / `multica issue search <keyword>` and use it.

### List / get / search

```bash
multica issue list --project <PID> --output json | jq '.issues[] | {identifier, status, assignee_id, title}'
multica issue get <id-or-identifier> --output json
multica issue search "M0.1"
```

### Assign + change status

```bash
multica issue assign <id> --to-id <squad-or-agent-uuid>      # by UUID
multica issue assign <id> --to "dev-team"                    # fuzzy name (member/agent/squad)
multica issue assign <id> --unassign                         # remove assignee
multica issue status <id> in_progress                        # valid: backlog/todo/in_progress/in_review/done/blocked/cancelled
```

### Rerun (re-enqueue a stuck assignment)

```bash
multica issue rerun <id> --output json
```

**When to use**: an issue is `in_progress` but the agent produced nothing (no branch, no commit, no PR) — the task got claimed but stalled. `rerun` re-enqueues a fresh task for the current assignee. **Do not** use this to change assignee — use `assign` for that.

### Comments (with the @-notification gotcha — read this)

```bash
# Multi-line comment: ALWAYS use --content-file or --content-stdin, not --content string
cat > /tmp/c.md <<'EOF'
[@backend-dev](mention://agent/e578945e-9ffb-4b29-9672-1a723dbc5db8) 请处理。
EOF
multica issue comment add <id> --content-file /tmp/c.md
```

**⚠️ @-notification format (critical, easy to get wrong):**

- ✅ **MUST** be: `[@<name>](mention://agent/<full-36-char-UUID>)`
- ❌ Plain text `@backend-dev`, `@agent`, `@assignee` → **"没有选中智能体"**, agent receives nothing.
- Use the **full UUID** (36 chars), not the first 8.
- To @ the assignee of an issue: `multica issue get <id>` → read `assignee_id` → look up name in your agent table → build the link.
- Issue links: `[@MZW-234](mention://issue/<issue-uuid>)`.

### Metadata (per-issue KV)

```bash
multica issue metadata set <id> original_dev=<agent-uuid>    # remember who dev'd, for review-then-restore
multica issue metadata get <id> original_dev
multica issue metadata list <id>
multica issue metadata delete <id> original_dev
```

**Use case**: when moving an issue to `in_review` and reassigning to `code-reviewer`, store the original developer in metadata so you can restore it if review requests changes.

### Runs + messages (execution history — the "liveness probe")

```bash
multica issue runs <id> --output json            # latest run status: running/queued/completed/failed
multica issue run-messages <run-id> --output json # the agent's streamed messages
multica issue pull-requests <id> --output json   # linked PRs (non-empty = has PR)
```

**Use case (liveness probe)**: before rerunning an `in_progress` issue, check whether it's actually stuck:
- `runs` latest status = `running`/`queued` → agent is working, **don't rerun**.
- `pull-requests` non-empty → has PR, **don't rerun**.
- No run, no PR, no recent comment → **stuck, rerun**.

## Agents + Squads

```bash
multica agent list --output json                  # id, name, status, runtime, model, archived
multica agent get <id>
multica agent update <id> --model ""              # clear model → fall back to runtime default
multica agent update <id> --model claude-opus-4-8
multica agent update <id> --max-concurrent-tasks 2
multica agent update <id> --instructions "..."
multica agent env <id>                            # custom env vars (audited)
multica agent skills <id> ...

multica squad list                                # id, name, leader_id, members
multica squad get <squad-id>                      # includes instructions (the squad's operating rules)
multica squad member ...                          # add/remove members
```

**Squad = group of agents + humans under a leader agent.** Assigning an issue to a squad lets the leader decide who picks it up (routing stays stable as team grows). Prefer squad assignment over individual agent assignment for team work.

## Autopilots (scheduled/triggered coordinators)

```bash
# Create (run_only = just coordinate; create_issue = also create work items)
multica autopilot create --title "..." --mode run_only --agent project-architect \
  --project <PID> --description "<full prompt>" --output json

# Add a schedule trigger (cron, IANA tz)
multica autopilot trigger-add <ap-id> --kind schedule --cron "*/20 * * * *" --timezone Asia/Shanghai

# Manual trigger (fire once now, outside schedule)
multica autopilot trigger <ap-id> --output json

# Inspect
multica autopilot get <ap-id> --output json       # includes triggers + full description
multica autopilot list
multica autopilot runs <ap-id> --output json      # execution history (status: completed/skipped/failed)

# Update / pause
multica autopilot update <ap-id> --description "<new prompt>"
multica autopilot update <ap-id> --status paused  # or active
```

**`--description` is the entire prompt** the coordinator agent runs each tick. It's the only place to encode the coordination rules (liveness probes, branch naming, review gates, @-notification format). A good autopilot description is long (2000+ words) and includes: role, core disciplines, mention-format rules, team UUID table, iteration loop steps, forbidden actions.

**Common run statuses**:
- `completed` — ran fine.
- `skipped` with `failure_reason: "agent runtime is offline at dispatch time"` — **the agent's local daemon is down**. Fix: `multica daemon start` on the machine that hosts the agent's runtime.
- `failed` — prompt error, look at `result`/`failure_reason`.

## Daemon (local agent runtime)

```bash
multica daemon start           # foreground; or backgrounds depending on version
multica daemon status          # is it running, which workspaces watched
multica daemon stop
multica daemon restart
multica daemon logs            # tail logs (agent spawn output, claim loop)
multica daemon disk-usage      # per-task/workspace disk
```

**The daemon is what makes `local`-runtime agents actually execute.** An agent shows `runtime: local` + `status: idle` in `agent list`, but if the daemon isn't running on the machine the agent is bound to, autopilots skip with "runtime offline". `multica setup` does login + daemon start in one shot.

## Configuration

```bash
multica config show
multica config set server_url https://021multica.zero2x.org
multica config set app_url https://021multica.zero2x.org/
multica auth status             # current user + token hint
multica auth logout
```

## Common Workflows (step-by-step)

### A. Triage all project issues (for an autopilot tick or manual review)

```bash
PID=f34a5b20-1893-4b96-973f-2e77205a178a
multica issue list --project $PID --output json | jq '
  .issues | group_by(.status) | map({status: .[0].status, count: length})'
```

Then for each `in_progress` issue, run the liveness probe (see §Runs + messages) and classify 🟢活跃/🟡沟通/🔴停滞/⛔失败循环.

### B. Dispatch a batch of issues (concurrency-limited)

```bash
# Assign up to N issues to a squad, set in_progress, notify the leader
SQUAD=7d17759a-f1f2-45a7-a08f-e97124563389
LEADER=55cb98bf-bfe2-42f7-8614-40b14e7c6c61   # project-architect
for id in <issue-id-1> <issue-id-2> <issue-id-3>; do
  multica issue assign "$id" --to-id "$SQUAD"
  multica issue status  "$id" in_progress
  printf '[@project-architect](mention://%s) 开始 %s。分支 issue/<identifier>。\n' "$LEADER" "$id" \
    | multica issue comment add "$id" --content-stdin
done
```

### C. Move an issue through review → merge → done

```bash
ID=<issue-id>
CODE_REVIEWER=ea0ab609-cec9-4c6e-856f-9db891d3036e

# 1. Remember dev, hand to reviewer
multica issue metadata set $ID original_dev=$(multica issue get $ID --output json | jq -r .assignee_id)
multica issue status  $ID in_review
multica issue assign  $ID --to-id $CODE_REVIEWER
printf '[@code-reviewer](mention://%s) 请对抗式评审。分支 issue/<id>。输出 APPROVE 或 REQUEST_CHANGES。\n' $CODE_REVIEWER \
  | multica issue comment add $ID --content-stdin

# 2. (after APPROVE comment appears) merge + done
#    — merge is git, not multica; then:
multica issue status $ID done
multica issue metadata delete $ID original_dev 2>/dev/null || true
```

### D. Create an autopilot coordinator (the hard part is the description)

```bash
AP=$(multica autopilot create --title "X 协调器" --mode run_only --agent project-architect \
  --project $PID --description-file /tmp/prompt.md --output json | jq -r .id)
multica autopilot trigger-add "$AP" --kind schedule --cron "0 * * * *" --timezone Asia/Shanghai
multica autopilot trigger "$AP"   # fire once to test
```

Write the description to a file (`--description-file` not available on `update`; for update use `--description "$(cat file)"`). Include in the prompt: role, disciplines, mention-format, team UUIDs, iteration steps, forbidden list. See the dagents autopilot (`bebfac1d`) and the reference minihackathon autopilot (`39f58aa1`) for examples.

## Gotchas & Lessons (from production coordinators)

1. **`in_progress` ≠ agent is working.** An agent claims a task, runs once, produces nothing, and the status stays `in_progress`. Always probe `runs`/`pull-requests`/comments before deciding to skip or rerun.
2. **Plain-text `@` does nothing.** Must be `[@name](mention://agent/<full-uuid>)`. This is the single most common coordinator failure.
3. **Branch naming drift.** Agents default to `agent/<role>/*` or `feature/*` in their own skills. Enforce `issue/<identifier>` in the dispatch comment and the autopilot prompt, or merges break.
4. **Don't skip review.** "Compiles → merge" is the failure mode. Always route through `code-reviewer` and require an explicit `APPROVE` comment before `git merge`.
5. **Rerun cap.** If an issue has been rerun ≥2 times with no output, stop rerunning — set back to `todo` or reassign. Infinite rerun burns tokens.
6. **Duplicate title block.** `issue create` rejects same-title active issues. Search first; the "duplicate" is usually the one you want.
7. **`--description` string vs file.** `create` has `--description-file`; `update` only has `--description` (string). For long prompts, `--description "$(cat file)"`.
8. **Runtime offline.** Autopilot `skipped` with "agent runtime is offline" → run `multica daemon start` on the agent's machine. The autopilot is fine; the daemon isn't.
9. **`identifier` vs `id`.** `identifier` (MZW-234) for humans, branches, chat. `id` (UUID) for API calls. Don't mix them in scripts.
10. **`--output json` is your friend.** Table output is for humans; always use json when parsing. Most create/update commands default to json already.

## Environment Variables

- `MULTICA_SERVER_URL` — override server
- `MULTICA_WORKSPACE_ID` — active workspace
- `MULTICA_DEBUG` — print full errors
- `--profile <name>` — isolate config/daemon/workspaces (e.g. `dev`)

## References

- Local source: `~/Projects/multica/CLI_AND_DAEMON.md`, `~/Projects/multica/CLI_INSTALL.md` (authoritative, from the repo)
- Server: https://021multica.zero2x.org
- In-repo autopilot example: `bebfac1d-deb8-4264-bc2e-16c91fabbe31` (dagents coordinator) + `docs/superpowers/specs/2026-07-08-mvp-execution-plan-design.md` for the project context
