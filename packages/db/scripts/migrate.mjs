#!/usr/bin/env node
/**
 * db:migrate —— 对 POSTGRES_URL 指向的库执行增量迁移（幂等）。
 *
 * 背景（QA L4 发现）：initDb() 只 initialize 不跑迁移，dev 库依赖手动
 * 同步 —— 新迁移只被测试库 globalSetup 应用，dev 网关在用旧 schema
 * （实例：dispatch_tasks.cancel_requested_at 缺失 → 取消端点 500）。
 * restart-gateway.sh 现在每次重启前自动跑本脚本，流程化防复发。
 *
 * 用法：pnpm --filter @dagents/db migrate   （读 POSTGRES_URL）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// .env 在仓库根（scripts → db → packages → root）；不覆盖已有环境变量
try {
  for (const line of readFileSync(join(here, '../../../.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
} catch {
  // 无 .env 时完全依赖环境变量
}

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL 未设置（.env 或环境）')
  process.exit(1)
}

const { AppDataSource } = await import('../dist/index.js')
await AppDataSource.initialize()
try {
  const migrations = await AppDataSource.runMigrations({ transaction: 'each' })
  if (migrations.length === 0) {
    console.log('db: schema already up to date')
  } else {
    for (const m of migrations) console.log(`db: applied ${m.name}`)
  }
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
}
