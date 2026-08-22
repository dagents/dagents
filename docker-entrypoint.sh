#!/usr/bin/env bash
# docker-entrypoint.sh — boots the dagents stack inside a single container.
#
#   1. wait for postgres to accept connections
#   2. run pending TypeORM migrations (@dagents/db)
#   3. start gateway (Hono on :8080) in the background
#   4. start console (Next.js standalone on :3000) in the foreground
#   5. forward SIGTERM/SIGINT to both, then exit
#
# bash, not sh: `wait -n` below is a bashism — Debian slim's dash rejects it
# ("Illegal option -n"), which took the container down right after boot.
# node:*-slim ships bash 5.2, and wait -n only gained PID args in 5.1+.
#
# PIDs are tracked so the trap can tear both processes down cleanly. The
# gateway is backgrounded and `wait`ed on so a crash in either app surfaces as
# a non-zero container exit (Docker then restarts per the service policy).
set -eu

GATEWAY_PID=""
CONSOLE_PID=""

# Tear down whatever we started, in reverse order. Idempotent — the trap may
# fire after one process has already exited.
shutdown() {
    echo "[entrypoint] received shutdown signal, draining…"
    if [ -n "$CONSOLE_PID" ] && kill -0 "$CONSOLE_PID" 2>/dev/null; then
        kill -TERM "$CONSOLE_PID" 2>/dev/null || true
    fi
    if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    fi
    # Give them a moment to flush, then force-kill if still alive.
    sleep 3
    if [ -n "$CONSOLE_PID" ] && kill -0 "$CONSOLE_PID" 2>/dev/null; then
        kill -KILL "$CONSOLE_PID" 2>/dev/null || true
    fi
    if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        kill -KILL "$GATEWAY_PID" 2>/dev/null || true
    fi
    exit 0
}
trap shutdown TERM INT

# -----------------------------------------------------------------------------
# 1. Wait for postgres.
#
# POSTGRES_URL is the app-level DSN (postgres://user:pass@host:5432/db) which
# the compose file overrides to point at the `postgres` service. pg_isready
# ships with the postgres client; the runtime image is node:20-slim with no psql
# tools, so fall back to a TCP probe on the host:port parsed out of the URL.
# -----------------------------------------------------------------------------
wait_for_postgres() {
    # Parse host:port from POSTGRES_URL (default to postgres:5432).
    url="${POSTGRES_URL:-}"
    host="postgres"
    port="5432"
    if [ -n "$url" ]; then
        # Strip scheme + creds: postgresql://user:pass@host:port/db → host:port/db
        rest="${url#*://}"
        rest="${rest#*@}"          # drop user:pass@
        hostport="${rest%%/*}"     # drop /db…
        host="${hostport%%:*}"
        port="${hostport#*:}"
        # If there was no port, keep the 5432 default.
        case "$port" in
            "$hostport") port="5432" ;;
        esac
    fi

    echo "[entrypoint] waiting for postgres at ${host}:${port}…"
    i=0
    until node -e "require('net').connect({host:'${host}',port:${port}}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; do
        i=$((i + 1))
        if [ "$i" -ge 60 ]; then
            echo "[entrypoint] postgres not reachable after 60s, giving up" >&2
            exit 1
        fi
        echo "[entrypoint] postgres not ready yet (${i}/60), retrying in 1s…"
        sleep 1
    done
    echo "[entrypoint] postgres is up."
}

# -----------------------------------------------------------------------------
# 2. Migrations.
#
# The db package's `migration:run` script invokes `typeorm-ts-node-esm`, which
# compiles the .ts migration sources on the fly (so we need the migrations/
# + entities/ source dirs in the image, not just dist). POSTGRES_URL is read by
# data-source.ts, so it just needs to be in the env.
# -----------------------------------------------------------------------------
run_migrations() {
    echo "[entrypoint] running pending migrations…"
    if ! pnpm --filter @dagents/db migration:run; then
        echo "[entrypoint] migrations failed" >&2
        exit 1
    fi
    echo "[entrypoint] migrations complete."
}

# -----------------------------------------------------------------------------
# 3 + 4 + 5. Boot + supervise.
# -----------------------------------------------------------------------------
wait_for_postgres
run_migrations

echo "[entrypoint] starting gateway on :8080…"
node apps/gateway/dist/index.js &
GATEWAY_PID=$!

echo "[entrypoint] starting console on :3000…"
# Next.js standalone emits server.js at .next/standalone/apps/console/server.js
# (it mirrors the repo layout from outputFileTracingRoot). Fall back to the
# next start wrapper if the standalone build isn't present.
CONSOLE_SERVER="apps/console/.next/standalone/apps/console/server.js"
if [ -f "$CONSOLE_SERVER" ]; then
    PORT=3000 HOSTNAME=0.0.0.0 node "$CONSOLE_SERVER" &
else
    echo "[entrypoint] standalone server.js not found at $CONSOLE_SERVER, falling back to next start" >&2
    pnpm --filter @dagents/console start &
fi
CONSOLE_PID=$!

echo "[entrypoint] gateway pid=${GATEWAY_PID} console pid=${CONSOLE_PID}"

# `wait -n` returns when *either* child exits; we then take the whole container
# down so a crash in one app doesn't leave the other running headless.
wait -n "$GATEWAY_PID" "$CONSOLE_PID"
EXIT_CODE=$?
echo "[entrypoint] a child exited (code=${EXIT_CODE}), shutting down the other…"
shutdown
