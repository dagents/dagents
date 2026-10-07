import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_RESTART_POLICY,
  defaultConfig,
  discoverRepoRoot,
  loadConfig,
} from './config'

// config 纯函数单测（docs §6 + §18.4 钉死语义，M8）：默认值合并 / 坏 JSON 容错 /
// 未知字段忽略 / 端口钉死（旧端口锁退役）。
// 夹具平台无关化（遗留债①）：绝对路径经 node:path 从 resolve('/') 推导——
// isAbsolute 语义在 win/linux 同真（旧 C:/ 族在 linux 全是相对路径 → CI 21 处失败源）。

/** 平台无关绝对路径根（win: C:\；posix: /）。 */
const ROOT = resolve('/')
const P = (...parts: string[]) => join(ROOT, ...parts)

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
  it('全量默认值（inScope 显式默认命令 + 默认端口 + portExplicit 派生标记）', () => {
    const c = defaultConfig(P('repo'))
    expect(c.repoRoot).toBe(P('repo'))
    expect(c.consoleUrl).toBe('') // '' = 由端口计划派生（§18.2——不再是固定字面量）
    expect(c.mode).toBe('auto')
    expect(c.services.gateway).toEqual({
      command: 'pnpm',
      args: ['--filter', '@dagents/gateway', 'dev'],
      port: 8080,
      portExplicit: false,
    })
    expect(c.services.console).toEqual({
      command: 'pnpm',
      args: ['--filter', '@dagents/console', 'dev'],
      port: 3000,
      portExplicit: false,
    })
    expect(c.restartPolicy).toEqual(DEFAULT_RESTART_POLICY)
    expect(c.logTailLines).toBe(400)
    expect(c.extraEnv).toEqual({})
    expect(c.postgres).toEqual({
      embedded: true,
      embeddedExplicit: false,
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
  const REPO = P('repo')
  const UD = P('userdata')

  it('无 config.json → 全量默认值、零 warning', () => {
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({ [norm(join(REPO, 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(warnings).toEqual([])
    expect(config.repoRoot).toBe(REPO)
    expect(config.services.gateway.port).toBe(8080)
  })

  it('合法配置覆盖默认值', () => {
    const json = JSON.stringify({
      repoRoot: P('checkouts', 'dagents'),
      services: {
        gateway: { command: 'node', args: ['dist/index.js'], port: 8080 },
        console: { command: 'pnpm', args: ['--filter', '@dagents/console', 'dev'], port: 3000 },
      },
      restartPolicy: { maxAttempts: 5, windowMs: 600_000, backoffMs: [500, 1500], healthTimeoutMs: 90_000 },
      logTailLines: 800,
      extraEnv: { PATH_EXTRA: 'x' },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: P('anywhere'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json }),
    })
    expect(warnings).toEqual([])
    expect(config.repoRoot).toBe(P('checkouts', 'dagents'))
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
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({
        [norm(join(UD, 'config.json'))]: '{not json at all',
        [norm(join(REPO, 'pnpm-workspace.yaml'))]: '',
      }),
    })
    expect(warnings.some((w) => w.includes('解析失败'))).toBe(true)
    expect(config.services.gateway.command).toBe('pnpm')
  })

  it('端口语义（§18.4，端口锁退役）：非默认端口 → 接受为钉死（portExplicit=true）', () => {
    const json = JSON.stringify({
      services: {
        gateway: { command: 'pnpm', args: ['--filter', '@dagents/gateway', 'dev'], port: 9999 },
        console: { command: 'pnpm', args: ['--filter', '@dagents/console', 'dev'], port: 3000 },
      },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(P('r'), 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(warnings).toEqual([]) // 超集放宽：不再拒绝（旧语义是回落+告警）
    expect(config.services.gateway.port).toBe(9999)
    expect(config.services.gateway.portExplicit).toBe(true) // 钉死——被陌生程序占时诚实 failed 不让位
    expect(config.services.console.portExplicit).toBe(false)
  })

  it('写默认端口（=8080/3000）→ 行为与不写一致（旧 config 零变化）', () => {
    const json = JSON.stringify({
      services: {
        gateway: { port: 8080 },
        console: { port: 3000 },
      },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(P('r'), 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(warnings).toEqual([])
    expect(config.services.gateway.port).toBe(8080)
    expect(config.services.gateway.portExplicit).toBe(false) // 默认值不构成钉死
    expect(config.services.console.portExplicit).toBe(false)
  })

  it('端口越界（<1024 / >65535 / 非整数）→ 回落默认 + warning（对齐 pg 校验先例）', () => {
    const json = JSON.stringify({
      services: {
        gateway: { port: 80 },
        console: { port: 70_000 },
      },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(P('r'), 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(config.services.gateway.port).toBe(8080)
    expect(config.services.gateway.portExplicit).toBe(false)
    expect(config.services.console.port).toBe(3000)
    expect(warnings.some((w) => w.includes('services.gateway.port=80') && w.includes('越界'))).toBe(true)
    expect(warnings.some((w) => w.includes('services.console.port=70000') && w.includes('越界'))).toBe(true)
  })

  it('extraEnv 与计划注入键冲突 → warning（placement 单源，防 env 旁路半残态）', () => {
    const json = JSON.stringify({
      extraEnv: { GATEWAY_PORT: '9000', PORT: '9100', GATEWAY_URL: 'http://x:1', OK: 'v' },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(P('r'), 'pnpm-workspace.yaml'))]: '' }),
    })
    // 值透传保留（spawn 时被计划值覆盖），但告警在位
    expect(config.extraEnv.GATEWAY_PORT).toBe('9000')
    expect(warnings.some((w) => w.includes('extraEnv.GATEWAY_PORT') && w.includes('实际端口为准'))).toBe(true)
    expect(warnings.some((w) => w.includes('extraEnv.PORT'))).toBe(true)
    expect(warnings.some((w) => w.includes('extraEnv.GATEWAY_URL'))).toBe(true)
    expect(warnings.some((w) => w.includes('extraEnv.OK'))).toBe(false)
  })

  it('consoleUrl 显式设置 → 保留 + 告知计划派生不生效（§18.2 逃生门语义）', () => {
    const json = JSON.stringify({ consoleUrl: 'http://localhost:3999' })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(P('r'), 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(config.consoleUrl).toBe('http://localhost:3999')
    expect(warnings.some((w) => w.includes('consoleUrl') && w.includes('显式设置'))).toBe(true)
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
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(P('r'), 'pnpm-workspace.yaml'))]: '' }),
    })
    // 未知字段被忽略；错误类型回落
    expect(config.repoRoot).toBe(P('r'))
    expect(config.consoleUrl).toBe('')
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
      userDataDir: UD,
      startDir: P('r'),
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json }),
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
  const ROOT2 = resolve('/')
  const P2 = (...parts: string[]) => join(ROOT2, ...parts)
  const UD = P2('ud')
  const REPO = P2('r')

  it('合法 postgres 覆盖：embedded:false + 自定义端口 + 绝对路径（平台无关）', () => {
    const json = JSON.stringify({
      postgres: {
        embedded: false,
        port: 60432,
        dataDir: P2('pgdata'),
        binDir: P2('pgbin'),
        migrateScript: P2('m.mjs'),
        pgRequireRoot: P2('gw'),
      },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(REPO, 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(warnings).toEqual([])
    expect(config.postgres).toEqual({
      embedded: false,
      embeddedExplicit: true,
      port: 60432,
      dataDir: P2('pgdata'),
      binDir: P2('pgbin'),
      migrateScript: P2('m.mjs'),
      pgRequireRoot: P2('gw'),
    })
  })

  it('embeddedExplicit 标记（dev 默认关内嵌 PG 的豁免依据，AC-7④）', () => {
    const mk = (postgres: unknown) =>
      loadConfig({
        userDataDir: UD,
        startDir: REPO,
        deps: mkDeps({
          [norm(join(UD, 'config.json'))]: JSON.stringify({ postgres }),
          [norm(join(REPO, 'pnpm-workspace.yaml'))]: '',
        }),
      }).config.postgres.embeddedExplicit
    expect(mk(undefined)).toBe(false) // 未写 postgres/embedded → 默认（dev 门控生效）
    expect(mk({ port: 55432 })).toBe(false) // 写了 postgres 但未写 embedded → 默认
    expect(mk({ embedded: true })).toBe(true) // 显式 true → dev 豁免
    expect(mk({ embedded: false })).toBe(true) // 显式 false → 第①层显式关
  })

  it('第②层回退：extraEnv.POSTGRES_URL 已设 → embedded 自动关 + warning', () => {
    const json = JSON.stringify({
      extraEnv: { POSTGRES_URL: 'postgresql://dagents:dagents_dev@localhost:15432/dagents' },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(REPO, 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(config.postgres.embedded).toBe(false)
    expect(warnings.some((w) => w.includes('外部库') && w.includes('15432'))).toBe(true)
  })

  it('postgres 值域校验：端口越界 / 相对路径 / 非法 embedded 均回落 + warning', () => {
    const json = JSON.stringify({
      postgres: { port: 80, embedded: 'yes', dataDir: 'relative/dir', binDir: 42 },
    })
    const { config, warnings } = loadConfig({
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: json, [norm(join(REPO, 'pnpm-workspace.yaml'))]: '' }),
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
    const mk = (mode: unknown) => JSON.stringify({ mode })
    const good = loadConfig({
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({
        [norm(join(UD, 'config.json'))]: mk('packaged'),
        [norm(join(REPO, 'pnpm-workspace.yaml'))]: '',
      }),
    })
    expect(good.config.mode).toBe('packaged')
    expect(good.warnings).toEqual([])
    const bad = loadConfig({
      userDataDir: UD,
      startDir: REPO,
      deps: mkDeps({ [norm(join(UD, 'config.json'))]: mk('cloud'), [norm(join(REPO, 'pnpm-workspace.yaml'))]: '' }),
    })
    expect(bad.config.mode).toBe('auto')
    expect(bad.warnings.some((w) => w.includes('mode'))).toBe(true)
  })
})
