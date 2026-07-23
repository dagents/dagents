#!/usr/bin/env bash
# Dev launcher: load .env into the shell, then run turbo dev.
#
# Why this exists: turbo does NOT auto-load `.env` files, and the repo has no
# `dotenv` dependency. A bare `pnpm dev` leaves POSTGRES_URL / REDIS_URL /
# FLOWISE_API_KEY / NEWAPI_BASE_URL unset, so the apps fall back to wrong
# ports (→ ECONNREFUSED) or return 503 ("flowise api key not configured").
# This script sources `.env` first so the same `globalEnv` keys turbo already
# declares are actually populated in the task processes.
#
# Usage:
#   scripts/dev.sh            # = pnpm dev, but with .env loaded
#   scripts/dev.sh logs       # tail a running dev session's logs
#   scripts/dev.sh stop       # stop the background dev session
#
# FLOWISE_API_KEY is auto-fetched from the Flowise DB (see __flowise_key) so it
# never has to be pasted into .env. Override by setting it in .env explicitly.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-$ROOT/.env}"

# --- load .env (if present) -----------------------------------------------
# Simple `KEY=value` parser: skips blanks/comments, no quoting/export/subshell.
# Keys here are already in turbo.json `globalEnv`, so turbo passes them through.
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key val; do
    # skip blank lines and comments (also inline comments after #)
    [[ -z "${key// }" || "${key}" =~ ^[[:space:]]*# ]] && continue
    # strip a trailing inline comment from the value
    val="${val%%#*}"
    # trim surrounding whitespace
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "$key" ]] && continue
    # only set if not already exported in the caller's env (caller wins)
    if [[ -z "${!key:-}" ]]; then
      export "$key=$val"
    fi
  done < "$ENV_FILE"
fi

# --- auto-fetch FLOWISE_API_KEY from the Flowise DB -----------------------
# The dev Flowise stores its platform API key in the `apikey` table (plaintext,
# `FpPA-…`). This avoids pasting a live credential into .env. No-op if the
# container isn't up or the key isn't provisioned yet — the gateway will 503
# and you can provision it later (see docs/m1-flowise-agent-verification.md).
__flowise_key() {
  if [[ -n "${FLOWISE_API_KEY:-}" ]]; then return; fi   # .env / caller wins
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^mil-agents-postgres-1$'; then
    return
  fi
  local key
  key="$(docker exec mil-agents-postgres-1 psql -U milagents -d flowise -t -A 2>/dev/null \
    -c 'SELECT "apiKey" FROM apikey WHERE "keyName"='"'"'mil-agents-m1'"'"' LIMIT 1;')" || true
  if [[ -n "$key" ]]; then
    export FLOWISE_API_KEY="$key"
  fi
}
__flowise_key

case "${1:-dev}" in
  stop)
    if [[ -f "$ROOT/.dev.pid" ]]; then
      kill "$(cat "$ROOT/.dev.pid")" 2>/dev/null || true
      rm -f "$ROOT/.dev.pid"
      echo "dev session stopped."
    else
      echo "no dev session running (no .dev.pid)."
    fi
    ;;
  logs)
    if [[ -f "$ROOT/.dev.log" ]]; then
      tail -f "$ROOT/.dev.log"
    else
      echo "no .dev.log — run scripts/dev.sh first."
      exit 1
    fi
    ;;
  dev|"")
    # Foreground (default): blocks the current shell, Ctrl-C kills turbo.
    exec pnpm dev
    ;;
  --bg|bg)
    # Background: write logs to .dev.log, pid to .dev.pid. `scripts/dev.sh logs`
    # tails; `scripts/dev.sh stop` kills. .dev.log / .dev.pid are gitignored.
    nohup pnpm dev > "$ROOT/.dev.log" 2>&1 &
    echo $! > "$ROOT/.dev.pid"
    echo "dev started in background (pid $(cat "$ROOT/.dev.pid")) — logs: scripts/dev.sh logs, stop: scripts/dev.sh stop"
    ;;
  *)
    echo "usage: scripts/dev.sh [dev|bg|logs|stop]" >&2
    exit 2
    ;;
esac
