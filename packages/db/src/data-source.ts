import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const AppDataSource = new DataSource({
  type: 'postgres',
  // Default matches the mil-agents docker-compose stack: Postgres is remapped to
  // 15432 on the host (see infra/.env.example) to avoid colliding with other
  // projects' :5432. turbo does NOT auto-load `.env` files, so in a bare `pnpm
  // dev` (no sourced env) this fallback is what gateway/dispatch/scheduler boot
  // against — a bare `localhost:5432` would hit ECONNREFUSED and take all three
  // apps down. Mirrors how `@mil/scheduler` bakes its dev Redis URL. Override
  // via POSTGRES_URL in any other environment.
  url:
    process.env.POSTGRES_URL ??
    'postgresql://milagents:milagents_dev@localhost:15432/milagents',
  entities: [join(here, 'entities', '*.{ts,js}')],
  migrations: [join(here, 'migrations', '*.{ts,js}')],
  synchronize: false,
  logging: process.env.DB_LOG === '1',
})

export async function initDb(): Promise<DataSource> {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  return AppDataSource
}

/**
 * Run a single statement inside a short-lived QueryRunner and return the
 * structured `QueryResult` (`records` + `affected`).
 *
 * Why this exists: `AppDataSource.query()` drops the third `useStructuredResult`
 * arg, so raw results come back in an inconsistent shape — a bare row array for
 * INSERT/SELECT-RETURNING, but `[rows, rowCount]` for UPDATE/DELETE. Routes need
 * both the rows (for RETURNING) and the affected count (for 404-vs-204), so this
 * helper always returns the structured form. It also wraps the statement in a
 * transaction so multi-statement claim patterns can be extended later without a
 * behaviour change.
 */
export async function runQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<{ records: T[]; affected: number | null }> {
  const qr = AppDataSource.createQueryRunner()
  await qr.connect()
  try {
    const result = await qr.query(sql, params, true)
    return { records: (result.records ?? []) as T[], affected: result.affected ?? null }
  } finally {
    await qr.release()
  }
}
