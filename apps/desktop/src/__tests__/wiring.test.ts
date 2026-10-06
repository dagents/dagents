import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// M1 接线守护：钉住「包骨架与 turbo 门禁/打包入口的契约」。
// 这些断言都是 vitest 运行时真实读文件，不 mock 任何东西；
// 编排器逻辑单测（state-machine / tree-kill 等）自 M2 起加入
// （docs/desktop-architecture.md §6 测试策略）。

const pkgRoot = join(__dirname, '..', '..')

function readPkg(): {
  name: string
  main: string
  scripts: Record<string, string>
  dependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'))
}

describe('M1 骨架接线', () => {
  const pkg = readPkg()

  it('包名 @dagents/desktop + main 指向 tsc 产物入口', () => {
    expect(pkg.name).toBe('@dagents/desktop')
    expect(pkg.main).toBe('dist/main/index.js')
  })

  it('四 script 齐备（turbo.json 的 build/test/lint/typecheck 按名纳入）', () => {
    for (const script of ['build', 'test', 'lint', 'typecheck']) {
      expect(pkg.scripts[script], `package.json scripts.${script} 缺失`).toBeTruthy()
    }
  })

  it('test script 同时跑 vitest 与打包配置齐备性校验', () => {
    expect(pkg.scripts.test).toContain('vitest run')
    expect(pkg.scripts.test).toContain('check-builder-config.mjs')
  })

  it('Electron 入口三件套源文件在位（main/preload/renderer）', () => {
    expect(existsSync(join(pkgRoot, 'src/main/index.ts'))).toBe(true)
    expect(existsSync(join(pkgRoot, 'src/preload/index.ts'))).toBe(true)
    expect(existsSync(join(pkgRoot, 'src/renderer/index.html'))).toBe(true)
  })

  it('零 runtime 依赖 + 零 workspace 依赖（turbo ^build 解析为空，不牵动兄弟包）', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })
})
