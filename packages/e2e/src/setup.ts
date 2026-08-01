/**
 * E2E test bootstrap (plan §Task M6.7).
 *
 * Points the suite at the docker-compose dev stack (Postgres :15432) and runs
 * pending migrations so `runs` / `run_node_spans` / `dispatch_tasks` exist on
 * a fresh DB. Same pattern as `packages/repro/src/__tests__/setup.ts`: vitest
 * `setupFiles` runs this module's top-level code once per file *before* any
 * test, so env defaults + migration run must be side effects at module load.
 *
 * `await` at top level is fine: vitest awaits an ESM setup module's top-level
 * await before starting the file's tests, so migrations finish first.
 */
import { AppDataSource, initDb } from '@dagents/db'

process.env.POSTGRES_URL ??=
  'postgresql://dagents:dagents_dev@localhost:15432/dagents'

await initDb()
await AppDataSource.runMigrations()
