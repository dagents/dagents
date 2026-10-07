import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { defaultConfig } from './config'
import {
  initdbSpec,
  migrateRunOnceSpec,
  parsePostmasterPid,
  pgCtlStopSpec,
  pgDsn,
  pgSpawnRunSpec,
  pickPgPort,
  PgServiceController,
  resolvePgPaths,
  type PgClient,
  type PgDeps,
  type PgRuntimePaths,
  type RunOnceSpec,
} from './pg-service'
import { ServiceSupervisor, type SupervisorOptions } from './supervisor'
import type { ServiceStatus } from './types'

// pg-service 单测（docs §10）：纯函数（挑端口/spec 构造/DSN/pid 解析/路径解析）+
// controller bootstrap 管线（注入假 deps 全速驱动）。真 initdb/postgres 链路归
// M5 真机验收，不进单测。

const paths: PgRuntimePaths = {
  binDir: 'C:/stage/pg/native/bin',
  dataDir: 'C:/ud/pgdata',
  migrateScript: 'C:/repo/packages/db/scripts/migrate.mjs',
  pgRequireRoot: 'C:/repo/packages/db',
  nodeRuntime: { command: 'node', env: {} },
}

// fake fs 的 key 与被测代码 join() 输出同构（win32 反斜杠）
const PG_BIN = join('C:/stage/pg/native/bin', 'postgres.exe')
const PG_VERSION_FILE = join('C:/ud/pgdata', 'PG_VERSION')
const POSTMASTER_PID = join('C:/ud/pgdata', 'postmaster.pid')

describe('pickPgPort（让位策略 docs §10.3）', () => {
  it('默认端口空闲 → 直用，未让位', async () => {
    expect(await pickPgPort(55432, async () => false)).toEqual({
      port: 55432,
      yielded: false,
      tried: 1,
    })
  })

  it('默认被占 → +1 递增直到空闲（明示让位）', async () => {
    const busy = new Set([55432, 55433])
    const choice = await pickPgPort(55432, async (p) => busy.has(p))
    expect(choice).toEqual({ port: 55434, yielded: true, tried: 3 })
  })

  it('全部被占（≤20 次）→ null 诚实失败', async () => {
    expect(await pickPgPort(55432, async () => true, 20)).toBeNull()
  })
})

describe('spec 构造（纯函数）', () => {
  it('pgDsn：无密码 trust + 本机回环', () => {
    expect(pgDsn(55432, 'dagents')).toBe('postgresql://dagents@127.0.0.1:55432/dagents')
  })

  it('initdbSpec：-U dagents -E UTF8 --locale=C -A trust', () => {
    const spec = initdbSpec(paths)
    expect(spec.command.endsWith('initdb.exe')).toBe(true)
    expect(spec.args).toEqual([
      '-D', 'C:/ud/pgdata', '-U', 'dagents', '-E', 'UTF8', '--locale=C', '-A', 'trust',
    ])
  })

  it('pgSpawnRunSpec：前台直跑 + 端口/host 注入', () => {
    const spec = pgSpawnRunSpec(paths, 55433)
    expect(spec.command.endsWith('postgres.exe')).toBe(true)
    expect(spec.args).toEqual(['-D', 'C:/ud/pgdata', '-p', '55433', '-h', '127.0.0.1'])
    expect(spec.cwd).toBe(paths.binDir)
  })

  it('migrateRunOnceSpec：node + POSTGRES_URL 注入', () => {
    const spec = migrateRunOnceSpec(paths, 'postgresql://dagents@127.0.0.1:55432/dagents')
    expect(spec.command).toBe('node')
    expect(spec.args).toEqual([paths.migrateScript])
    expect(spec.env).toEqual({ POSTGRES_URL: 'postgresql://dagents@127.0.0.1:55432/dagents' })
  })

  it('migrateRunOnceSpec（packaged）：execPath + ELECTRON_RUN_AS_NODE 载体（docs §11.1）', () => {
    const packaged: PgRuntimePaths = {
      ...paths,
      nodeRuntime: { command: 'C:/app/dagents.exe', env: { ELECTRON_RUN_AS_NODE: '1' } },
    }
    const spec = migrateRunOnceSpec(packaged, 'postgresql://dagents@127.0.0.1:55432/dagents')
    expect(spec.command).toBe('C:/app/dagents.exe')
    expect(spec.env).toEqual({
      POSTGRES_URL: 'postgresql://dagents@127.0.0.1:55432/dagents',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('pgCtlStopSpec：-m fast -w -t 5 stop', () => {
    const spec = pgCtlStopSpec(paths)
    expect(spec.command.endsWith('pg_ctl.exe')).toBe(true)
    expect(spec.args).toEqual(['-D', 'C:/ud/pgdata', '-m', 'fast', '-w', '-t', '5', 'stop'])
  })
})

describe('parsePostmasterPid / resolvePgPaths', () => {
  it('postmaster.pid 首行 PID 解析；垃圾内容 → null', () => {
    expect(parsePostmasterPid('4242\nC:/ud/pgdata\n55432\n')).toBe(4242)
    expect(parsePostmasterPid('')).toBeNull()
    expect(parsePostmasterPid('not-a-pid\n')).toBeNull()
  })

  it('resolvePgPaths：null 字段落默认（userData/pgdata + desktop staging + repo db）', () => {
    const norm = (p: string) => p.replace(/\\/g, '/')
    const pg = defaultConfig('C:/repo').postgres
    const resolved = resolvePgPaths(pg, {
      userDataDir: 'C:/ud',
      desktopDir: 'C:/repo/apps/desktop',
      repoRoot: 'C:/repo',
    })
    expect(norm(resolved.binDir)).toBe('C:/repo/apps/desktop/stage/pg/native/bin')
    expect(norm(resolved.dataDir)).toBe('C:/ud/pgdata')
    expect(norm(resolved.migrateScript)).toBe('C:/repo/packages/db/scripts/migrate.mjs')
    expect(norm(resolved.pgRequireRoot)).toBe('C:/repo/packages/db')
    expect(resolved.nodeRuntime).toEqual({ command: 'node', env: {} })
  })

  it('resolvePgPaths（packaged）：binDir/migrate/pg 驱动/node 载体全指 resources（docs §11.4）', () => {
    const norm = (p: string) => p.replace(/\\/g, '/')
    const pg = defaultConfig('C:/repo').postgres
    const resolved = resolvePgPaths(pg, {
      userDataDir: 'C:/ud',
      desktopDir: 'C:/repo/apps/desktop',
      repoRoot: 'C:/repo',
      packaged: {
        servicesDir: 'C:/app/resources/services',
        pgNativeDir: 'C:/app/resources/pg/native',
        execPath: 'C:/app/dagents.exe',
      },
    })
    expect(norm(resolved.binDir)).toBe('C:/app/resources/pg/native/bin')
    expect(norm(resolved.dataDir)).toBe('C:/ud/pgdata') // 数据目录仍在 userData（卸载保留语义）
    expect(norm(resolved.migrateScript)).toBe(
      'C:/app/resources/services/gateway/node_modules/@dagents/db/scripts/migrate.mjs'
    )
    expect(norm(resolved.pgRequireRoot)).toBe('C:/app/resources/services/gateway')
    expect(resolved.nodeRuntime).toEqual({
      command: 'C:/app/dagents.exe',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('resolvePgPaths：显式配置优先', () => {
    const resolved = resolvePgPaths(
      {
        embedded: true,
        embeddedExplicit: true,
        port: 55432,
        dataDir: 'D:/mydata',
        binDir: 'D:/pbbin',
        migrateScript: 'D:/m.mjs',
        pgRequireRoot: 'D:/gateway',
      },
      { userDataDir: 'C:/ud', desktopDir: 'C:/d', repoRoot: 'C:/repo' }
    )
    expect(resolved.dataDir).toBe('D:/mydata')
    expect(resolved.binDir).toBe('D:/pbbin')
    expect(resolved.migrateScript).toBe('D:/m.mjs')
    expect(resolved.pgRequireRoot).toBe('D:/gateway')
  })
})

/** controller 假世界：手动时钟 + 假文件系统 + runOnce 队列 + 假 pg 客户端。 */
class PgFake {
  now = 1_000_000
  timers = new Map<number, { cb: () => void; at: number }>()
  private seq = 1
  files = new Map<string, string>()
  alivePids = new Set<number>()
  openPorts = new Set<number>()
  runOnceQueue: { code: number; stdout?: string; stderr?: string; effect?: () => void }[] = []
  runOnceSpecs: RunOnceSpec[] = []
  spawned: RunOnceSpec[] = []
  pgQueries: string[] = []
  pgDatabaseExists = true
  /** connectPg 按次抛错队列（崩溃恢复窗口测试：每次连接 shift 一条，空则正常）。 */
  pgConnectErrors: string[] = []
  logs: string[] = []
  emits = 0
  private nextPid = 7000

  readonly deps: PgDeps = {
    spawnService: (_id, spec) => {
      this.spawned.push({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
      })
      const pid = this.nextPid++
      return {
        pid,
        onExit: () => {},
        onStdout: () => {},
        onStderr: () => {},
      }
    },
    httpGet: async () => ({ error: 'unused' }),
    isPortOpen: async (p) => this.openPorts.has(p),
    killTree: () => {},
    now: () => this.now,
    setTimer: (cb, ms) => {
      const id = this.seq++
      this.timers.set(id, { cb, at: this.now + ms })
      return { id }
    },
    clearTimer: (h) => this.timers.delete((h as { id: number }).id),
    log: (_id, line) => this.logs.push(line),
    getLogTail: () => this.logs.slice(-30),
    existsSync: (p) => this.files.has(p),
    readFileUtf8: (p) => this.files.get(p) ?? null,
    removeFile: (p) => {
      this.files.delete(p)
    },
    runOnce: async (spec) => {
      this.runOnceSpecs.push(spec)
      const next = this.runOnceQueue.shift() ?? { code: 0 }
      next.effect?.()
      return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' }
    },
    connectPg: async () => {
      const world = this
      const err = world.pgConnectErrors.shift()
      if (err !== undefined) throw new Error(err)
      const client: PgClient = {
        async query(sql) {
          world.pgQueries.push(sql)
          if (sql.includes('pg_database')) return { rows: world.pgDatabaseExists ? [{ ok: 1 }] : [] }
          return { rows: [] }
        },
        async end() {},
      }
      return client
    },
    isProcessAlive: (pid) => this.alivePids.has(pid),
  }

  makeController(opts: { healthTimeoutMs?: number } = {}) {
    const world = this
    const config = defaultConfig('C:/repo')
    if (opts.healthTimeoutMs !== undefined) config.restartPolicy.healthTimeoutMs = opts.healthTimeoutMs
    const controller = new PgServiceController(config, world.deps, {
      paths,
      createSupervisor: (options: SupervisorOptions) =>
        new ServiceSupervisor('pg', world.deps, config, () => world.emits++, options),
      emit: () => {
        world.emits++
      },
    })
    return { config, controller }
  }

  /** postgres spawn 后模拟端口监听（TCP 探活转绿）。 */
  simulatePostgresListening(): void {
    const spec = this.spawned[0]
    const pIdx = spec ? spec.args.indexOf('-p') : -1
    if (pIdx >= 0) this.openPorts.add(Number(spec.args[pIdx + 1]))
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (let guard = 0; guard < 400; guard++) {
      for (let i = 0; i < 8; i++) await Promise.resolve()
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) break
      for (const [id, t] of due) {
        this.timers.delete(id)
        this.now = Math.max(this.now, t.at)
        t.cb()
        for (let i = 0; i < 8; i++) await Promise.resolve()
      }
    }
    this.now = target
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

describe('PgServiceController bootstrap 管线', () => {
  /** 首启世界：二进制在位 + initdb/migrate 应答。 */
  function freshWorld() {
    const fake = new PgFake()
    fake.files.set(PG_BIN, 'bin')
    fake.runOnceQueue = [
      { code: 0, stdout: 'initdb ok' }, // initdb（dataDir 无 PG_VERSION）
      { code: 0, stdout: 'db: applied 1700000000000-Init' }, // migrate
    ]
    return fake
  }

  /** 已初始化世界：PG_VERSION 在位（跳过 initdb），队列只剩 migrate。 */
  function initializedWorld() {
    const fake = new PgFake()
    fake.files.set(PG_BIN, 'bin')
    fake.files.set(PG_VERSION_FILE, '16')
    fake.runOnceQueue = [{ code: 0, stdout: 'db: schema already up to date' }]
    return fake
  }

  /** 驱动 start 至落定（spawn 后模拟端口监听）。 */
  async function driveStart(fake: PgFake, controller: PgServiceController) {
    const started = controller.start()
    await fake.advance(5)
    fake.simulatePostgresListening()
    await fake.advance(3_000)
    return started
  }

  it('二进制缺失 → failed + 指引 ensure:postgres，不碰文件系统', async () => {
    const fake = new PgFake() // 无 postgres.exe
    const { controller } = fake.makeController()
    const res = await controller.start()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('ensure:postgres')
    expect(controller.status().state).toBe('failed')
    expect(fake.runOnceSpecs).toEqual([])
  })

  it('端口全被占 → failed 诚实失败（≤20 次让位耗尽）', async () => {
    const fake = freshWorld()
    for (let p = 55432; p < 55432 + 20; p++) fake.openPorts.add(p)
    const { controller } = fake.makeController()
    const res = await controller.start()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('全被占用')
    expect(fake.spawned).toEqual([]) // 未 spawn postgres
  })

  it('initdb 失败 → failed 带输出尾，不 spawn postgres', async () => {
    const fake = freshWorld()
    fake.runOnceQueue[0] = { code: 1, stderr: 'initdb: error: directory exists but not empty' }
    const { controller } = fake.makeController()
    const res = await controller.start()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not empty')
    expect(controller.status().state).toBe('failed')
    expect(fake.spawned).toEqual([])
  })

  it('已初始化（PG_VERSION 在位）→ 跳过 initdb 直接起库', async () => {
    const fake = initializedWorld()
    const { controller } = fake.makeController()
    const res = await driveStart(fake, controller)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.dsn).toBe('postgresql://dagents@127.0.0.1:55432/dagents')
    // 无 initdb，仅 migrate 一次 runOnce
    expect(fake.runOnceSpecs.map((s) => s.command)).toEqual(['node'])
    expect(controller.status().state).toBe('running')
    expect(controller.actualPort).toBe(55432)
  })

  it('stale postmaster.pid（PID 已死）→ 自动清锁后正常起库', async () => {
    const fake = initializedWorld()
    fake.files.set(POSTMASTER_PID, '99999\nC:/ud/pgdata\n55432\n')
    // 99999 不在 alivePids → stale
    const { controller } = fake.makeController()
    const res = await driveStart(fake, controller)
    expect(res.ok).toBe(true)
    expect(fake.files.has(POSTMASTER_PID)).toBe(false)
    expect(fake.logs.some((l) => l.includes('stale postmaster.pid'))).toBe(true)
  })

  it('postmaster.pid 属活进程 → failed 明示（不静默删数据）', async () => {
    const fake = initializedWorld()
    fake.files.set(POSTMASTER_PID, '4242\nC:/ud/pgdata\n55432\n')
    fake.alivePids.add(4242)
    const { controller } = fake.makeController()
    const res = await controller.start()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('4242')
    expect(fake.files.has(POSTMASTER_PID)).toBe(true) // 未删
    expect(fake.spawned).toEqual([])
  })

  it('库不存在 → CREATE DATABASE；已存在 → 跳过（幂等）', async () => {
    const fake = initializedWorld()
    fake.pgDatabaseExists = false
    const { controller } = fake.makeController()
    const res = await driveStart(fake, controller)
    expect(res.ok).toBe(true)
    expect(fake.pgQueries.some((q) => q.includes('CREATE DATABASE dagents'))).toBe(true)
  })

  it('建库踩崩溃恢复窗口（FATAL starting up）→ 窗口内重试后成功（真机缺陷①）', async () => {
    const fake = initializedWorld()
    // 非干净关机后的物理事实：端口已 accept，但前两次连接吃恢复期 FATAL
    fake.pgConnectErrors = [
      'the database system is starting up',
      'the database system is starting up',
    ]
    const { controller } = fake.makeController()
    const res = await driveStart(fake, controller)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.dsn).toBe('postgresql://dagents@127.0.0.1:55432/dagents')
    expect(fake.logs.some((l) => l.includes('崩溃恢复窗口'))).toBe(true)
    expect(controller.status().state).toBe('running')
  })

  it('建库持续失败超过恢复窗口（30s）→ 才判 failed（有界重试）', async () => {
    const fake = initializedWorld()
    fake.pgConnectErrors = Array.from({ length: 60 }, () => 'the database system is starting up')
    const { controller } = fake.makeController()
    const started = controller.start()
    await fake.advance(20)
    fake.simulatePostgresListening()
    await fake.advance(3_000) // 起库健康 → 进入建库重试环
    await fake.advance(35_000) // 推过 30s 窗口 → 耗尽判死
    const res = await started
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('建库失败')
    expect(controller.status().state).toBe('failed')
  })

  it('postgres 起不来（健康持续失败）→ 等待超时 failed', async () => {
    const fake = initializedWorld()
    // healthTimeoutMs 压到 2s：supervisor 重启链与 controller 等待（2s+5s）都快速可达
    const { controller } = fake.makeController({ healthTimeoutMs: 2_000 })
    const started = controller.start()
    await fake.advance(20) // spawn + 轮询开始（端口不开 → 持续失败）
    await fake.advance(9_000) // 推过 controller 等待 deadline（2s+5s）→ timeout
    const res = await started
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('未达健康')
    expect(controller.status().state).toBe('failed')
  })

  it('migrate 失败 → failed（gateway 不启动语义，error 文案）', async () => {
    const fake = initializedWorld()
    fake.runOnceQueue[0] = { code: 1, stderr: 'ECONNREFUSED 127.0.0.1:55432' }
    const { controller } = fake.makeController()
    const res = await driveStart(fake, controller)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('迁移失败')
    expect(controller.status().state).toBe('failed')
  })

  it('stop：pg_ctl fast → 端口释放断言 → stopped', async () => {
    const fake = initializedWorld()
    const { controller } = fake.makeController()
    const res = await driveStart(fake, controller)
    expect(res.ok).toBe(true)
    expect(fake.openPorts.has(55432)).toBe(true)

    // pg_ctl stop 应答：副作用 = 端口释放（postgres 退出的物理事实）
    fake.runOnceQueue.push({
      code: 0,
      stdout: 'server stopped',
      effect: () => fake.openPorts.delete(55432),
    })
    const stopped = controller.stop()
    await fake.advance(100)
    await fake.advance(2_500)
    expect(await stopped).toBe(true)
    expect(controller.status().state).toBe('stopped')
    const ctl = fake.runOnceSpecs.find((s) => s.command.includes('pg_ctl'))
    expect(ctl?.args).toEqual(['-D', 'C:/ud/pgdata', '-m', 'fast', '-w', '-t', '5', 'stop'])
    expect(fake.logs.some((l) => l.includes('停净'))).toBe(true)
  })

  it('markSkipped：状态投影诚实（附加模式）', () => {
    const fake = new PgFake()
    const { controller } = fake.makeController()
    controller.markSkipped('附加模式：不启动')
    const st = controller.status()
    expect(st.state).toBe('idle')
    expect(st.message).toContain('附加模式')
    expect(controller.actualPort).toBe(null)
    expect(fake.logs.some((l) => l.includes('附加模式'))).toBe(true)
  })

  it('enabled=false → start 直接 skipped（外部 PG 不抢连接）', async () => {
    const fake = new PgFake()
    const { config, controller } = fake.makeController()
    config.postgres.embedded = false
    const res = await controller.start()
    expect(res.ok).toBe(true)
    expect(controller.status().state).toBe('idle')
    expect(controller.status().message).toContain('外部 Postgres')
    expect(fake.runOnceSpecs).toEqual([])
  })
})

describe('status 投影形状', () => {
  it('pg 状态是完整 ServiceStatus', () => {
    const fake = new PgFake()
    const { controller } = fake.makeController()
    const st: ServiceStatus = controller.status()
    expect(st.id).toBe('pg')
    expect(st.db).toBe('unknown')
    expect(st.attachMode).toBe(false)
  })
})
