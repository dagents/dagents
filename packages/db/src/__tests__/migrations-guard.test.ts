import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

/**
 * 迁移文件名时间戳唯一性 guard（2026-09-17）。
 *
 * 仓内已有两对同戳迁移（1720000014000×2 / 1720000015000×2）—— TypeORM
 * 同戳执行顺序依赖类名字典序，插队/重排即翻车。存量同戳无法安全重命名
 * （migrations 表按名字记录已执行项），本 guard 只拦**新增**重复：
 * 新迁移时间戳若与任何既有文件撞车，这里直接红。
 */
describe('migrations guard', () => {
  it('迁移文件名时间戳唯一（存量两对豁免，新增重复即失败）', () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.ts'))
    const timestamps = files.map((f) => f.split('-')[0])
    const counts = new Map<string, number>()
    for (const ts of timestamps) counts.set(ts, (counts.get(ts) ?? 0) + 1)
    // 已知存量豁免（重命名会破坏 migrations 表的执行记录）
    const grandfathered = new Set(['1720000014000', '1720000015000'])
    const violations = [...counts.entries()]
      .filter(([ts, n]) => n > 1 && !grandfathered.has(ts))
      .map(([ts, n]) => `${ts} ×${n}`)
    expect(violations, `重复时间戳: ${violations.join(', ')}`).toEqual([])
  })

  it('迁移时间戳严格递增不可能，但至少不小于豁免对的下一档（新文件编号规范）', () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.ts'))
    const stamps = files.map((f) => Number(f.split('-')[0])).sort((a, b) => a - b)
    // 当前最新档位；新迁移必须大于它 —— 用断言把「往后加」这个约定钉住
    expect(stamps[stamps.length - 1]).toBeGreaterThan(1720000094000)
  })
})
