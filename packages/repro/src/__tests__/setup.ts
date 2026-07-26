/**
 * Test bootstrap: point repro at the docker-compose dev stack and run pending
 * migrations so `pipeline_versions` + `runs` exist even on a fresh DB.
 *
 * Same pattern as apps/scheduler/src/__tests__/setup.ts: vitest `setupFiles`
 * runs this module's top-level code once per test file *before* any test, so
 * the env defaults + migration run must be side effects at module load. The dev
 * infra remaps Postgres→15432 and MinIO→9000 (see infra/.env.example).
 *
 * `await` at top level is fine: vitest awaits an ESM setup module's top-level
 * await before starting the file's tests, so migrations finish first.
 */
import { AppDataSource, initDb } from '@dagents/db'

process.env.POSTGRES_URL ??=
  'postgresql://dagents:dagents_dev@localhost:15432/dagents'

// MinIO dev creds (infra/.env.example). Tests that need a different store
// override these before constructing the S3 client.
process.env.MINIO_ENDPOINT ??= 'http://localhost:9000'
process.env.MINIO_ACCESS_KEY ??= 'dagents'
process.env.MINIO_SECRET_KEY ??= 'dagents_dev'
process.env.MINIO_BUCKET ??= 'dagents'

await initDb()
// Run pending migrations so `pipeline_versions` exists on a fresh DB.
// Idempotent: already-applied migrations are skipped by the TypeORM runner.
await AppDataSource.runMigrations()
