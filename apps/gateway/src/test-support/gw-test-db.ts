/**
 * Vitest globalSetup — gateway 单测专用测试库的自动供给。
 *
 * 为什么存在：gateway 的集成测试（dispatch / audit / chats / …15 个文件）
 * 曾经直连 dev 库 —— dispatch 两个文件甚至 `DELETE FROM runs` 全表 wipe，
 * 每跑一次单测就清空 dev 库全部真实运行历史（2026-08-29 核实产品现状时
 * 定位：runs 表被清到只剩测试种子 `flow-1` 孤儿行）。
 *
 * 拓扑（对齐 e2e 的 dagents_e2e 模式，见 tests/e2e/README.md）：
 *   1. 连 Postgres 维护库（postgres），`CREATE DATABASE dagents_gw_test`
 *      （已存在则跳过 —— Postgres 无 CREATE DATABASE IF NOT EXISTS）。
 *   2. 设 `process.env.POSTGRES_URL` 指向测试库 —— 必须发生在 worker
 *      import `@dagents/db` **之前**：AppDataSource 在模块构造时捕获 env
 *      （e2e seed.ts 同款约束）。globalSetup 在 worker fork 之前运行，
 *      env 随 fork 继承。
 *   3. 经 @dagents/db 的 DataSource 跑迁移（dist 内置 migrations），
 *      typeorm 迁移表保证幂等 —— 测试库可重复使用、增量补齐。
 *
 * 服务器地址取自 POSTGRES_URL 的 host/凭证（本机 docker :15432、CI 服务
 * 容器 :5432 均适用），只替换库名 —— dev 库从此零触碰。
 */
import { Client } from 'pg'

const GW_TEST_DB = 'dagents_gw_test'

export default async function setup(): Promise<void> {
  const base = process.env.POSTGRES_URL
    ?? 'postgresql://dagents:dagents_dev@localhost:15432/dagents'

  const adminUrl = new URL(base)
  adminUrl.pathname = '/postgres'
  const client = new Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    const { rows } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [GW_TEST_DB],
    )
    if (rows.length === 0) {
      // 库名是常量不是输入，无法参数化 —— 引号包裹足够
      await client.query(`CREATE DATABASE "${GW_TEST_DB}"`)
      console.log(`[gw-test-db] created database ${GW_TEST_DB}`)
    }
  } finally {
    await client.end()
  }

  // 先设 env 再动态 import —— AppDataSource 在模块构造时捕获 POSTGRES_URL
  const testUrl = new URL(base)
  testUrl.pathname = `/${GW_TEST_DB}`
  process.env.POSTGRES_URL = testUrl.toString()

  const { AppDataSource } = await import('@dagents/db')
  try {
    await AppDataSource.initialize()
    await AppDataSource.runMigrations({ transaction: 'each' })
    console.log(`[gw-test-db] migrations applied on ${GW_TEST_DB}`)
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  }
}

/**
 * dev 库保险丝（2026-09-20）：凡是 wipe 共享表（runs 等）的集成测试，
 * beforeEach 动手前先调这个 —— POSTGRES_URL 注入一旦失手（env 时序 /
 * 启动方式差异），在这里炸成显式失败，而不是把 dev 库真实运行历史
 * 全表清掉（2026-08-29 与 2026-09-20 两次实锤，后者不可恢复）。
 */
export function assertTestDatabase(dataSource: {
  options: { url?: string; database?: string }
}): void {
  // AppDataSource 走 url 配置 —— 库名在 url 的 pathname 里（options.database 为空）
  let db = dataSource.options?.database ?? ''
  if (!db && dataSource.options?.url) {
    try {
      db = new URL(dataSource.options.url).pathname.replace(/^\//, '')
    } catch {
      /* 不可解析按未知处理 */
    }
  }
  if (!db || db === 'dagents') {
    throw new Error(
      `[gw-test-db] 拒绝在「${db || '未知'}」库上执行 wipe —— POSTGRES_URL 注入失手，` +
        '继续跑会清空 dev 库真实数据。请经 apps/gateway 的 vitest 配置启动测试（globalSetup 负责注入 dagents_gw_test）。',
    )
  }
}
