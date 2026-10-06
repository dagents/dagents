import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RESTART_POLICY,
  defaultConfig,
  discoverRepoRoot,
  loadConfig,
} from './config'

// config 纯函数单测（docs §6）：默认值合并 / 坏 JSON 容错 / 未知字段忽略 / 端口锁。

describe('discoverRepoRoot', () => {
  it('从深层目录向上找到 pnpm-workspace.yaml 所在目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagents-desktop-cfg-'))
    try {
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
      await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
      expect(discoverRepoRoot(join(root, 'apps', 'desktop'))).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('找不到 → 回落 startDir（诚实失败，不猜）', () => {
    const dir = tmpdir()
    expect(discoverRepoRoot(dir)).toBe(dir)
  })
})

describe('defaultConfig', () => {
  it('全量默认值（inScope 显式默认命令 + 端口锁）', () => {
    const c = defaultConfig('C:/repo')
    expect(c.repoRoot).toBe('C:/repo')
    expect(c.consoleUrl).toBe('http://localhost:3000')
    expect(c.mode).toBe('auto')
    expect(c.services.gateway).toEqual({
      command: 'pnpm',
      args: ['--filter', '@dagents/gateway', 'dev'],
      port: 8080,
    })
    expect(c.services.console).toEqual({
      command: 'pnpm',
      args: ['--filter', '@dagents/console', 'dev'],
      port: 3000,
    })
    expect(c.restartPolicy).toEqual(DEFAULT_RESTART_POLICY)
    expect(c.logTailLines).toBe(400)
    expect(c.extraEnv).toEqual({})
    expect(c.postgres).toEqual({
      embedded: true,
      port: 55432,
      dataDir: null,
      binDir: null,
      migrateScript: null,
      pgRequireRoot: null,
    })
  })
})

describe('loadConfig', () => {
  // 路径 key 统一按正斜杠比较（node:path.join 在 win32 产反斜杠，测试 key 需归一）
  const norm = (p: string) => p.replace(/\\/g, '/')
  const mkDeps = (files: Record<string, string>) => ({
    existsSync: (p: string) => norm(p) in files,
    readFileSync: (p: string) => {
      const hit = files[norm(p)]
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
  })

  it('无 config.json → 全量默认值、零 warning', () => {
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/userdata',
      startDir: 'C:/repo',
      deps: mkDeps({ 'C:/repo/pnpm-workspace.yaml': '' }),
    })
    expect(warnings).toEqual([])
    expect(config.repoRoot).toBe('C:/repo')
    expect(config.services.gateway.port).toBe(8080)
  })

  it('合法配置覆盖默认值', () => {
    const json = JSON.stringify({
      repoRoot: 'D:/checkouts/dagents',
      consoleUrl: 'http://localhost:3000',
      services: {
        gateway: { command: 'node', args: ['dist/index.js'], port: 8080 },
        console: { command: 'pnpm', args: ['--filter', '@dagents/console', 'dev'], port: 3000 },
      },
      restartPolicy: { maxAttempts: 5, windowMs: 600_000, backoffMs: [500, 1500], healthTimeoutMs: 90_000 },
      logTailLines: 800,
      extraEnv: { PATH_EXTRA: 'x' },
    })
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/anywhere',
      deps: mkDeps({ 'C:/ud/config.json': json }),
    })
    expect(warnings).toEqual([])
    expect(config.repoRoot).toBe('D:/checkouts/dagents')
    expect(config.services.gateway.command).toBe('node')
    expect(config.services.gateway.args).toEqual(['dist/index.js'])
    expect(config.restartPolicy.maxAttempts).toBe(5)
    expect(config.restartPolicy.backoffMs).toEqual([500, 1500])
    expect(config.restartPolicy.healthTimeoutMs).toBe(90_000)
    expect(config.logTailLines).toBe(800)
    expect(config.extraEnv).toEqual({ PATH_EXTRA: 'x' })
  })

  it('坏 JSON → 默认值 + warning，不抛出', () => {
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/repo',
      deps: mkDeps({ 'C:/ud/config.json': '{not json at all', 'C:/repo/pnpm-workspace.yaml': '' }),
    })
    expect(warnings.some((w) => w.includes('解析失败'))).toBe(true)
    expect(config.services.gateway.command).toBe('pnpm')
  })

  it('端口锁：配置非 8080/3000 → 回落默认并告警（BFF GATEWAY_URL 耦合）', () => {
    const json = JSON.stringify({
      services: {
        gateway: { command: 'pnpm', args: ['--filter', '@dagents/gateway', 'dev'], port: 9999 },
        console: { command: 'pnpm', args: ['--filter', '@dagents/console', 'dev'], port: 3000 },
      },
    })
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': json, 'C:/r/pnpm-workspace.yaml': '' }),
    })
    expect(config.services.gateway.port).toBe(8080)
    expect(warnings.some((w) => w.includes('9999') && w.includes('GATEWAY_URL'))).toBe(true)
  })

  it('未知字段忽略、类型错误逐项回落', () => {
    const json = JSON.stringify({
      totallyUnknown: { a: 1 },
      repoRoot: 12345, // 错误类型 → 默认（walk-up 发现）
      consoleUrl: 'ftp://bad',
      logTailLines: 'lots',
      services: { gateway: { command: 'x', args: 'not-array', port: 8080 } },
      restartPolicy: { maxAttempts: -1, backoffMs: [100, 'bad', 200] },
      extraEnv: { OK: 'v', BAD: 42 },
    })
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': json, 'C:/r/pnpm-workspace.yaml': '' }),
    })
    // 未知字段被忽略；错误类型回落
    expect(config.repoRoot).toBe('C:/r')
    expect(config.consoleUrl).toBe('http://localhost:3000')
    expect(warnings.some((w) => w.includes('consoleUrl'))).toBe(true)
    expect(config.logTailLines).toBe(400)
    expect(config.services.gateway.command).toBe('x') // command 合法保留
    expect(config.services.gateway.args).toEqual(['--filter', '@dagents/gateway', 'dev']) // args 坏 → 默认
    expect(config.services.gateway.port).toBe(8080) // 8080 合法保留
    expect(config.restartPolicy.maxAttempts).toBe(DEFAULT_RESTART_POLICY.maxAttempts) // -1 非法 → 默认
    expect(config.restartPolicy.backoffMs).toEqual([100, 200]) // 坏项被剔除，合法项保留
    expect(config.extraEnv).toEqual({ OK: 'v' }) // 坏值剔除
  })

  it('越界数值夹取（logTailLines / windowMs 上限）', () => {
    const json = JSON.stringify({ logTailLines: 99_999, restartPolicy: { windowMs: 99_999_999_999 } })
    const { config } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': json }),
    })
    expect(config.logTailLines).toBe(2000)
    expect(config.restartPolicy.windowMs).toBe(3_600_000)
  })
})

describe('postgres.* 与 mode 合并（docs §10.4 三层不抢连接）', () => {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const mkDeps = (files: Record<string, string>) => ({
    existsSync: (p: string) => norm(p) in files,
    readFileSync: (p: string) => {
      const hit = files[norm(p)]
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
  })

  it('合法 postgres 覆盖：embedded:false + 自定义端口 + 绝对路径', () => {
    const json = JSON.stringify({
      postgres: {
        embedded: false,
        port: 60432,
        dataDir: 'D:/pgdata',
        binDir: 'D:/pgbin',
        migrateScript: 'D:/m.mjs',
        pgRequireRoot: 'D:/gw',
      },
    })
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': json, 'C:/r/pnpm-workspace.yaml': '' }),
    })
    expect(warnings).toEqual([])
    expect(config.postgres).toEqual({
      embedded: false,
      port: 60432,
      dataDir: 'D:/pgdata',
      binDir: 'D:/pgbin',
      migrateScript: 'D:/m.mjs',
      pgRequireRoot: 'D:/gw',
    })
  })

  it('第②层回退：extraEnv.POSTGRES_URL 已设 → embedded 自动关 + warning', () => {
    const json = JSON.stringify({
      extraEnv: { POSTGRES_URL: 'postgresql://dagents:dagents_dev@localhost:15432/dagents' },
    })
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': json, 'C:/r/pnpm-workspace.yaml': '' }),
    })
    expect(config.postgres.embedded).toBe(false)
    expect(warnings.some((w) => w.includes('外部库') && w.includes('15432'))).toBe(true)
  })

  it('postgres 值域校验：端口越界 / 相对路径 / 非法 embedded 均回落 + warning', () => {
    const json = JSON.stringify({
      postgres: { port: 80, embedded: 'yes', dataDir: 'relative/dir', binDir: 42 },
    })
    const { config, warnings } = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': json, 'C:/r/pnpm-workspace.yaml': '' }),
    })
    expect(config.postgres.port).toBe(55432)
    expect(config.postgres.embedded).toBe(true)
    expect(config.postgres.dataDir).toBeNull()
    expect(config.postgres.binDir).toBeNull()
    expect(warnings.some((w) => w.includes('postgres.port'))).toBe(true)
    expect(warnings.some((w) => w.includes('postgres.embedded'))).toBe(true)
    expect(warnings.some((w) => w.includes('postgres.dataDir'))).toBe(true)
    expect(warnings.some((w) => w.includes('postgres.binDir'))).toBe(true)
  })

  it('mode：合法 auto/dev/packaged 透传，非法回落 auto + warning', () => {
    const mk = (mode: unknown) =>
      JSON.stringify({ mode })
    const good = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({
        'C:/ud/config.json': mk('packaged'),
        'C:/r/pnpm-workspace.yaml': '',
      }),
    })
    expect(good.config.mode).toBe('packaged')
    expect(good.warnings).toEqual([])
    const bad = loadConfig({
      userDataDir: 'C:/ud',
      startDir: 'C:/r',
      deps: mkDeps({ 'C:/ud/config.json': mk('cloud'), 'C:/r/pnpm-workspace.yaml': '' }),
    })
    expect(bad.config.mode).toBe('auto')
    expect(bad.warnings.some((w) => w.includes('mode'))).toBe(true)
  })
})
