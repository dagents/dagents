/**
 * Test bootstrap: point the scheduler at the docker-compose dev stack and run
 * pending migrations so the `runs` table exists even on a fresh DB.
 *
 * This runs as a vitest `setupFiles` entry, which executes the module's
 * top-level code once per test file *before* any test runs — so the env
 * defaults + migration run must be side effects at module load, not a named
 * export. (A named `export async function setup()` is never called by vitest's
 * `setupFiles` mechanism — that only auto-runs `globalSetup`, not per-file
 * `setupFiles` — so env would stay unset and every Redis test would hit
 * `NOAUTH`. This is the cold-start failure M3.2 fixed; M3.1 mirrors the fix.)
 *
 * The dev infra remaps Postgres→15432 and Redis→16479 (see infra/README.md);
 * set those as defaults so `pnpm test` works without a local .env. The Redis
 * in this stack requires a password (`dagents_dev`), so the default REDIS_URL
 * carries it — a bare `redis://localhost:16479` would hit `NOAUTH` and every
 * Redis-touching test would fail (same rationale as the inline defaults in
 * `semaphore.test.ts` / `fanout.test.ts`). Tests that need a different Redis
 * override REDIS_URL before creating the client.
 *
 * `await` at top level is fine here: vitest awaits an ESM setup module's
 * top-level await before starting the file's tests, so migrations finish first.
 */
import { AppDataSource, initDb } from '@dagents/db'

process.env.POSTGRES_URL ??=
  'postgresql://dagents:dagents_dev@localhost:15432/dagents'
process.env.REDIS_URL ??= 'redis://localhost:16479'

await initDb()
// Run pending migrations so `runs` exists on a fresh DB. Idempotent: already
// applied migrations are skipped by the TypeORM runner.
await AppDataSource.runMigrations()
