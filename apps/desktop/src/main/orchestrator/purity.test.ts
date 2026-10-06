import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 架构守护测试（docs §6）：orchestrator/ 是纯逻辑核心——禁 import electron，
// 防止编排器被绑死 Electron（将来想复用为 CLI 时拆不出）。

const dir = join(__dirname)

describe('orchestrator 纯度守护', () => {
  it('orchestrator/ 下所有源码不得引用 electron（import/require 均禁）', () => {
    const offenders: string[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue
      const text = readFileSync(join(dir, file), 'utf-8')
      // 匹配对 electron 模块的静态引用（ESM import 与 require 两种形态，含 type import）
      if (/from\s+['"]electron['"]/.test(text) || /require\(\s*['"]electron['"]\s*\)/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it('实现文件与测试文件成对存在（每模块都有单测钉住）', () => {
    const impls = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const tests = new Set(readdirSync(dir).filter((f) => f.endsWith('.test.ts')))
    const missing = impls.filter((f) => {
      if (f === 'types.ts') return false // 纯类型文件，由消费方测试覆盖
      return !tests.has(f.replace(/\.ts$/, '.test.ts'))
    })
    expect(missing).toEqual([])
  })
})
