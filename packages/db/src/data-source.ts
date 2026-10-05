import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const AppDataSource = new DataSource({
  type: 'postgres',
  // Default matches the dagents docker-compose stack: Postgres is remapped to
  // 15432 on the host (see infra/.env.example) to avoid colliding with other
  // projects' :5432. turbo does NOT auto-load `.env` files, so in a bare `pnpm
  // dev` (no sourced env) this fallback is what gateway boots against — a bare
  // `localhost:5432` would hit ECONNREFUSED. Override via POSTGRES_URL in any
  // other environment.
  url:
    process.env.POSTGRES_URL ??
    'postgresql://dagents:dagents_dev@localhost:15432/dagents',
  entities: [join(here, 'entities', '*.{ts,js}')],
  migrations: [join(here, 'migrations', '*.{ts,js}')],
  synchronize: false,
  logging: process.env.DB_LOG === '1',
  // 连接池显式调优（稳定性专项 2026-10-04）：TypeORM 默认把 pg Pool 参数
  // 藏在 extra 里且 max=10 不透明。connectionTimeout 5s 让池耗尽/DB 抖动时
  // 请求快速失败（→ /health 503 + 错误信封），而不是无限挂起堆叠超时。
  // node-spans 轮询 + SSE + run 写入的并发画像下，10 连接足够；全部可经
  // 环境变量覆盖。
  extra: {
    max: dbNumEnv('DB_POOL_MAX', 10),
    idleTimeoutMillis: dbNumEnv('DB_POOL_IDLE_MS', 30_000),
    connectionTimeoutMillis: dbNumEnv('DB_POOL_CONNECT_TIMEOUT_MS', 5_000),
  },
})

function dbNumEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

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

/**
 * 多语句原子写（2026-09-17 评审补齐）：回调内的每条语句走同一个
 * QueryRunner 的显式事务 —— 中途抛错整体回滚，杜绝「消息写进去了、
 * chat 状态还停在 running」这类半写状态。
 *
 * 回调收到一个与 runQuery 同形的 `tx` 函数。注意：不要在回调里再调
 * runQuery/嵌套 withTransaction（会拿到事务外的连接，破坏原子性）。
 * 用法：
 *
 *   await withTransaction(async (tx) => {
 *     await tx(`INSERT INTO ...`, [...])
 *     await tx(`UPDATE ...`, [...])
 *   })
 */
export async function withTransaction<T>(
  work: (
    tx: <R = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => Promise<{ records: R[]; affected: number | null }>,
  ) => Promise<T>,
): Promise<T> {
  const qr = AppDataSource.createQueryRunner()
  await qr.connect()
  await qr.startTransaction()
  const tx = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const result = await qr.query(sql, params, true)
    return { records: (result.records ?? []) as R[], affected: result.affected ?? null }
  }
  try {
    const out = await work(tx)
    await qr.commitTransaction()
    return out
  } catch (err) {
    await qr.rollbackTransaction()
    throw err
  } finally {
    await qr.release()
  }
}
