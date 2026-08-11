# syntax=docker/dockerfile:1.7

# =============================================================================
# Stage 1 — builder
#   Installs the full monorepo and runs `turbo run build`, producing the
#   compiled artifacts (gateway dist/, packages/*/dist/, console .next/) that
#   the runtime stage copies over.
# =============================================================================
FROM node:20-slim AS builder

# pnpm is pinned in the root package.json via packageManager; corepack resolves
# the exact version, so we just enable it here. (The package.json field is the
# source of truth — see https://nodejs.org/api/corepack.html.)
RUN corepack enable

WORKDIR /app

# Copy only the workspace manifests + lockfile first so the install layer is
# cached across source changes. turbo.json is needed by `pnpm run build`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./

# Install the entire workspace (all apps/* + packages/* + vendor/*). The
# lockfile is committed, so --frozen-lockfile keeps the install reproducible.
# .npmrc sets ignore-scripts=true, so no postinstall hooks run (vendored
# agentflow has no .git, so its husky install would otherwise fail).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Now copy the rest of the source. .dockerignore strips node_modules / dist /
# .next / .git so this only moves real source files.
COPY . .

# turbo builds every workspace in dependency order (contracts → shared/db → …
# → gateway / console). Each package's build script emits to its own dist/ (or
# .next/ for the console).
RUN pnpm run build

# =============================================================================
# Stage 2 — runtime
#   Slim image carrying only what's needed to run gateway + console. No
#   devDeps, no source, no toolchain — just node, node_modules, built artifacts,
#   and the manifests pnpm needs at runtime (for the migration filter).
# =============================================================================
FROM node:20-slim AS runtime

# wget is used by HEALTHCHECK; the slim image doesn't ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Default to production so the console's next start doesn't try to hot-reload.
ENV NODE_ENV=production
# Gateway binds 127.0.0.1 by default (see apps/gateway/src/index.ts); inside
# Docker that means only the container's loopback can reach it, so the
# healthcheck + port mapping both fail. Bind 0.0.0.0 here — the compose file
# binds the published port to 127.0.0.1 on the host, so this doesn't widen the
# host surface.
ENV GATEWAY_HOST=0.0.0.0

# Copy the install state + manifests. We re-run a production-only install so
# devDeps (tsup, tsx, vitest, eslint, …) don't ship to the runtime image.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc /app/pnpm-lock.yaml ./
COPY --from=builder /app/apps/gateway/package.json ./apps/gateway/
COPY --from=builder /app/apps/console/package.json ./apps/console/
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/workflow/package.json ./packages/workflow/
COPY --from=builder /app/packages/agent-adapters/package.json ./packages/agent-adapters/
COPY --from=builder /app/vendor/agentflow/package.json ./vendor/agentflow/

# corepack again so the runtime pnpm matches the builder's (needed by the
# entrypoint's migration filter).
RUN corepack enable \
    && pnpm install --frozen-lockfile --prod

# Built artifacts.
COPY --from=builder /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/workflow/dist ./packages/workflow/dist
COPY --from=builder /app/packages/agent-adapters/dist ./packages/agent-adapters/dist
# Migrations are .ts, but the runtime runs them via typeorm-ts-node-esm, which
# needs the .ts sources (not the dist) — copy them alongside the compiled db.
COPY --from=builder /app/packages/db/src/migrations ./packages/db/src/migrations
COPY --from=builder /app/packages/db/src/entities ./packages/db/src/entities
COPY --from=builder /app/packages/db/src/data-source.ts ./packages/db/src/data-source.ts

# Console: Next.js standalone output. `output: 'standalone'` in next.config.mjs
# bundles a self-contained server.js + only the deps it traces, under
# .next/standalone. We also need the static + server-rendered chunks that live
# outside standalone (public/ + .next/static).
COPY --from=builder /app/apps/console/.next/standalone ./apps/console/.next/standalone
COPY --from=builder /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=builder /app/apps/console/public ./apps/console/public

# Entrypoint: waits for postgres, runs migrations, then boots both apps.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Gateway (8080) + console (3000).
EXPOSE 3000 8080

# Probe the gateway's public health endpoint. The compose file binds these
# ports to 127.0.0.1 on the host, but the healthcheck runs *inside* the
# container, where the gateway listens on 0.0.0.0 (see GATEWAY_HOST above).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
