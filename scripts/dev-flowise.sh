#!/usr/bin/env bash
# Start the vendored Flowise server for local dev (:3101).
#
# Flowise is deliberately NOT in the infra docker-compose stack (CLAUDE.md) —
# it's run from source. Its server config lives at
# vendor/flowise/packages/server/.env.dagents (PORT=3101, shared
# dagents Postgres:15432 / Redis:16479, IFRAME_ORIGINS=http://localhost:3000).
#
# HTTP_SECURITY_CHECK=false is REQUIRED: the M2 DispatchInvoke tool node calls
# the gateway at http://localhost:8080, and Flowise's SSRF guard would otherwise
# reject that as a denied host ("Access to this host is denied by policy.").
# See docs/m2-canvas-e2e-verification.md §2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/vendor/flowise/packages/server"

# Symlink the dagents config into the filename Flowise reads (.env), without
# clobbering a hand-edited .env if the user already has one.
if [[ ! -e .env && -f .env.dagents ]]; then
  ln -sf .env.dagents .env
fi

echo "starting Flowise on :3101 (config: .env -> $(readlink .env 2>/dev/null || echo .env))"
exec env HTTP_SECURITY_CHECK=false pnpm --filter flowise start
