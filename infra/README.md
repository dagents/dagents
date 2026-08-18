# Dagents Local Infrastructure

One-command local stack: **Postgres + Langfuse**, the two services the
platform runs on for development and integration testing.

## Bring up

```bash
cd infra
cp .env.example .env        # optional — defaults are baked into the compose file
docker compose up -d
docker compose ps           # expect 2 services healthy (plus 1 exited init helper)
```

Acceptance gates (per M0.2):

```bash
# Langfuse web UI:    http://localhost:3001
```

## Port map

Host-side ports are bound to `127.0.0.1` only. The canonical service port
(Langfuse 3001) is free on the dev machine, so it is bound as-is — matching
the plan and the acceptance gates verbatim. Only Postgres (5432) collides
with other projects on the dev machine, so its host-side binding is remapped;
the in-network service port stays canonical, so inter-container wiring (DSNs,
`depends_on`) is unaffected. Override any host port via `.env` (see
`.env.example`).

| Service  | Host port (default) | In-network |
|----------|---------------------|------------|
| Postgres | 15432 → 5432        | 5432       |
| Langfuse | 3001 → 3000         | 3000       |

## Databases

- `POSTGRES_DB=dagents` is created by the Postgres image on first boot.
- The `langfuse` database is created by the one-shot `postgres-init` container
  (idempotent — `createdb` failing on an existing DB is swallowed and the
  container exits 0).

## Langfuse: why v2, not v3

The plan wrote `langfuse/langfuse:latest`, which at the time meant v2.x. The
`:latest` tag has since moved to **v3.x**, which **requires ClickHouse**
(`CLICKHOUSE_URL`) and a Postgres v2→v3 migration — a much heavier stack than
this local dev environment needs. We pin to **`langfuse/langfuse:2.95.11`**
(the latest v2.x release): v2 stores traces in Postgres only, matching the
plan's "PG + Langfuse, no extra stores" intent.

**Upgrade trigger.** Move to v3 (and add a ClickHouse service) when we
actually need v3-only features (e.g. the new evals/analytics surface, higher
trace throughput). Until then v2.95.11 is sufficient and the lighter choice.

## Tear down

```bash
cd infra
docker compose down           # stop, keep volumes (data survives)
docker compose down -v        # stop AND wipe volumes (fresh start)
```

## Notes

- All long-lived services set `restart: unless-stopped`; the `*-init` helper
  sets `restart: "no"` (it runs once and exits).
