# Mil-Agents Local Infrastructure

One-command local stack: **Postgres + Redis + MinIO + new-api + Langfuse**, the
five services the MVP runs on for development and integration testing.

## Bring up

```bash
cd infra
cp .env.example .env        # optional — defaults are baked into the compose file
docker compose up -d
docker compose ps           # expect 5 services healthy (plus 2 exited init helpers)
```

Acceptance gates (per M0.2):

```bash
curl -s http://localhost:3000/api/status    # new-api status JSON
# new-api web admin: http://localhost:3000  →  root / 123456
# Langfuse web UI:    http://localhost:3001
# MinIO console:      http://localhost:9001  →  dagents / dagents_dev
```

## Port map

Host-side ports are bound to `127.0.0.1` only. The canonical service ports
(new-api 3000, MinIO 9000/9001, Langfuse 3001) are free on the dev machine, so
they are bound as-is — matching the plan and the acceptance gates verbatim. Only
Postgres (5432) and Redis (6379) collide with other projects on the dev machine,
so their host-side bindings are remapped; the in-network service ports stay
canonical, so inter-container wiring (DSNs, `mc host`, `depends_on`) is
unaffected. Override any host port via `.env` (see `.env.example`).

| Service  | Host port (default) | In-network |
|----------|---------------------|------------|
| Postgres | 15432 → 5432        | 5432       |
| Redis    | 16479 → 6379        | 6379       |
| MinIO    | 9000 → 9000 (API)   | 9000       |
| MinIO    | 9001 → 9001 (UI)    | 9001       |
| new-api  | 3000 → 3000         | 3000       |
| Langfuse | 3001 → 3000         | 3000       |

## Databases & buckets

- `POSTGRES_DB=dagents` is created by the Postgres image on first boot.
- The `newapi` and `langfuse` databases are created by the one-shot
  `postgres-init` container (idempotent — `createdb` failing on an existing DB
  is swallowed and the container exits 0).
- The `dagents` MinIO bucket is created by the one-shot `minio-init`
  container (same idempotent pattern with `mc mb -p`).

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

- All long-lived services set `restart: unless-stopped`; the two `*-init`
  helpers set `restart: "no"` (they run once and exit).
