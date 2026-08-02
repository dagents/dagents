#!/usr/bin/env bash
# Dev launcher: load .env into the shell, then run turbo dev.
#
# Why this exists: turbo does NOT auto-load `.env` files, and the repo has no
# `dotenv` dependency. A bare `pnpm dev` leaves POSTGRES_URL / GATEWAY_URL
# unset, so the apps fall back to wrong ports (→ ECONNREFUSED).
# This script sources `.env` first so the same `globalEnv` keys turbo already
# declares are actually populated in the task processes.
#
# Usage:
#   scripts/dev.sh            # = pnpm dev, but with .env loaded
#   scripts/dev.sh --with-daemon  # also start a daemon worker alongside
#   scripts/dev.sh logs       # tail a running dev session's logs
#   scripts/dev.sh stop       # stop the background dev session

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

# --- preflight checks -----------------------------------------------------
# Catch common environment drift before it causes confusing runtime errors.

# 1. Warn about stale env vars that reference removed services.
if [[ -f "$ENV_FILE" ]]; then
  STALE_VARS=()
  while IFS='=' read -r key val; do
    [[ -z "${key// }" || "${key}" =~ ^[[:space:]]*# ]] && continue
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$key" in
      DISPATCH_URL|SCHEDULER_URL|REDIS_URL|NEWAPI_BASE_URL|NEWAPI_ADMIN_KEY|NEWAPI_ADMIN_USER_ID|TOKEN_PROBE_INTERVAL_MS|MINIO_*)
        # DISPATCH_URL is only stale if it points at port 8081 (old dispatch).
        if [[ "$key" == "DISPATCH_URL" && "$val" == *:8081* ]]; then
          STALE_VARS+=("$key (→ port 8081, should be 8080)")
        elif [[ "$key" != "DISPATCH_URL" ]]; then
          STALE_VARS+=("$key")
        fi
        ;;
    esac
  done < "$ENV_FILE"
  if (( ${#STALE_VARS[@]} > 0 )); then
    echo "⚠️  .env contains stale variables from removed services:" >&2
    for v in "${STALE_VARS[@]}"; do
      echo "    - $v" >&2
    done
    echo "   These services have been removed. Copy .env.example to .env for the current config." >&2
    echo "   Continuing anyway in 3s…" >&2
    sleep 3
  fi
fi

# 2. Check macOS file descriptor limit (turbo dev needs >256 for 12 packages).
if [[ "$(ulimit -n)" -lt 10000 ]]; then
  echo "⚠️  ulimit -n is $(ulimit -n) — turbo dev may hit EMFILE errors." >&2
  echo "   Run 'ulimit -n 65536' before starting dev, or use 'scripts/dev.sh --bg'." >&2
fi

case "${1:-dev}" in
  stop)
    if [[ -f "$ROOT/.dev.pid" ]]; then
      kill "$(cat "$ROOT/.dev.pid")" 2>/dev/null || true
      rm -f "$ROOT/.dev.pid"
      echo "dev session stopped."
    else
      echo "no dev session running (no .dev.pid)."
    fi
    # Also kill daemon if we started it
    if [[ -f "$ROOT/.dev-daemon.pid" ]]; then
      kill "$(cat "$ROOT/.dev-daemon.pid")" 2>/dev/null || true
      rm -f "$ROOT/.dev-daemon.pid"
      echo "daemon stopped."
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
  --with-daemon)
    # Start turbo dev in background, then daemon in foreground.
    # Ctrl-C kills both (daemon gets SIGTERM via trap).
    echo "starting turbo dev (background) + daemon (foreground)…"
    nohup pnpm dev > "$ROOT/.dev.log" 2>&1 &
    echo $! > "$ROOT/.dev.pid"
    # Wait a moment for dispatch to come up before daemon tries to register
    sleep 3
    export DISPATCH_URL="${DISPATCH_URL:-http://localhost:8080}"
    DAEMON_LABEL="${DAEMON_LABEL:-dev-laptop}"
    DAEMON_TYPE="${DAEMON_TYPE:-claude}"
    pnpm --filter @dagents/daemon dev -- "$DISPATCH_URL" "$DAEMON_LABEL" "$DAEMON_TYPE" &
    DAEMON_PID=$!
    echo $DAEMON_PID > "$ROOT/.dev-daemon.pid"
    trap 'kill $DAEMON_PID 2>/dev/null; kill "$(cat "$ROOT/.dev.pid")" 2>/dev/null; rm -f "$ROOT/.dev.pid" "$ROOT/.dev-daemon.pid"' INT TERM
    echo "dev + daemon running — daemon logs on this terminal, dev logs: scripts/dev.sh logs"
    wait $DAEMON_PID
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
    echo "usage: scripts/dev.sh [dev|--with-daemon|bg|logs|stop]" >&2
    exit 2
    ;;
esac
