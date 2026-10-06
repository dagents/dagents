import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { defaultConfig } from './config'
import type { PgClient, PgDeps, RunOnceSpec } from './pg-service'
import {
  computePhase,
  healthResultToEvent,
  healthUrl,
  Orchestrator,
  ServiceSupervisor,
  type HttpResult,
  type SpawnHandle,
} from './supervisor'
import type { ServiceId, ServiceStatus } from './types'

// supervisor 单测：假时钟/假 HTTP/假 spawn 全速驱动（docs §6 编排器核心场景），
// 不碰真进程真网络——真子进程树终止与真端口探测在 tree-kill.test.ts / ports.test.ts。
// M5 起 FakeWorld 同时实现 PgDeps（runOnce/connectPg/假文件系统）驱动内嵌 PG 管线。

/** 假世界：手动时钟 + 定时器队列 + 可编排的 HTTP 应答队列 + spawn 记录。 */
class FakeWorld {
  now = 1_000_000
  timers = new Map<number, { cb: () => void; at: number }>()
  private timerSeq = 1
  logs: Record<ServiceId, string[]> = { gateway: [], console: [], pg: [] }
  httpQueue: HttpResult[] = []
  httpRequests: string[] = []
  /** 端口占用集合（附加模式 / PG 让位测试的开关）。 */
  openPorts = new Set<number>()
  spawnedSpecs: { id: ServiceId; command: string; args: string[]; cwd: string; env?: Record<string, string> }[] = []
  killedPids: number[] = []
  spawnHandles: FakeSpawnHandle[] = []
  /** runOnce 应答队列（initdb/migrate/pg_ctl stop），可附带副作用。 */
  runOnceQueue: { code: number; stdout?: string; stderr?: string; effect?: () => void }[] = []
  runOnceSpecs: RunOnceSpec[] = []
  /** connectPg 假客户端：库存在与否 + 是否抛错。 */
  pgDatabaseExists = true
  pgConnectError: string | null = null
  pgQueries: string[] = []
  /** 假文件系统（existsSync/readFileUtf8/removeFile/isProcessAlive）。 */
  files = new Map<string, string>()
  alivePids = new Set<number>()
  /** pg spawn 后监听的端口（fake 世界的「postgres 起来端口就开」）。 */
  pgSpawnPort: number | null = null
  private nextPid = 1000

  deps: PgDeps = {
    spawnService: (id, spec) => {
      this.spawnedSpecs.push({ id, command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env })
      const handle = new FakeSpawnHandle(this.nextPid++)
      this.spawnHandles.push(handle)
      if (id === 'pg') {
        const pIdx = spec.args.indexOf('-p')
        const port = pIdx >= 0 ? Number(spec.args[pIdx + 1]) : NaN
        if (Number.isFinite(port)) {
          this.pgSpawnPort = port
          this.openPorts.add(port)
        }
      }
      return handle
    },
    httpGet: async (url, timeoutMs) => {
      expect(timeoutMs).toBeGreaterThan(0)
      this.httpRequests.push(url)
      const next = this.httpQueue.shift()
      return next ?? { error: 'ECONNREFUSED (queue empty)' }
    },
    isPortOpen: async (port) => this.openPorts.has(port),
    killTree: (pid) => {
      this.killedPids.push(pid)
      for (const h of this.spawnHandles) if (h.pid === pid) h.markExited(1)
    },
    now: () => this.now,
    setTimer: (cb, ms) => {
      const id = this.timerSeq++
      this.timers.set(id, { cb, at: this.now + ms })
      return { id } as object
    },
    clearTimer: (handle) => {
      const id = (handle as { id: number }).id
      this.timers.delete(id)
    },
    log: (id, line) => this.logs[id].push(line),
    getLogTail: (id, n) => this.logs[id].slice(-n),
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
      if (this.pgConnectError !== null) throw new Error(this.pgConnectError)
      const world = this
      const client: PgClient = {
        async query(sql) {
          world.pgQueries.push(sql)
          if (sql.includes('pg_database')) {
            return { rows: world.pgDatabaseExists ? [{ ok: 1 }] : [] }
          }
          return { rows: [] }
        },
        async end() {},
      }
      return client
    },
    isProcessAlive: (pid) => this.alivePids.has(pid),
  }

  /** 推进假时钟，触发所有到期定时器（含级联：退避到期 → spawn → 轮询 0ms）。 */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (let guard = 0; guard < 200; guard++) {
      // 每轮先冲刷微任务——被测代码常在 await 链之后才注册下一个定时器
      for (let i = 0; i < 8; i++) await Promise.resolve()
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) break
      for (const [id, t] of due) {
        this.timers.delete(id)
        this.now = Math.max(this.now, t.at)
        t.cb()
        // 让 pollOnce 的微任务/await 落地
        for (let i = 0; i < 8; i++) await Promise.resolve()
      }
    }
    this.now = target
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

class FakeSpawnHandle implements SpawnHandle {
  exitCb: ((code: number | null) => void) | null = null
  stdoutCb: ((chunk: string) => void) | null = null
  stderrCb: ((chunk: string) => void) | null = null
  constructor(readonly pid: number) {}

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb
  }
  onStdout(cb: (chunk: string) => void): void {
    this.stdoutCb = cb
  }
  onStderr(cb: (chunk: string) => void): void {
    this.stderrCb = cb
  }
  emitStdout(chunk: string): void {
    this.stdoutCb?.(chunk)
  }
  emitStderr(chunk: string): void {
    this.stderrCb?.(chunk)
  }
  markExited(code: number | null): void {
    this.exitCb?.(code)
  }
}

function makeSup(id: ServiceId, world: FakeWorld) {
  return new ServiceSupervisor(id, world.deps, defaultConfig('C:/repo'), () => {})
}

describe('healthResultToEvent（判活协议 docs §3.1）', () => {
  it('gateway：200+ok:true → HEALTH_OK up', () => {
    expect(healthResultToEvent('gateway', { status: 200, body: '{"ok":true,"db":"up"}' })).toEqual({
      type: 'HEALTH_OK',
      db: 'up',
    })
  })

  it('gateway：503+db:down → HEALTH_OK down（进程活着，DB 未就绪——不重启）', () => {
    expect(healthResultToEvent('gateway', { status: 503, body: '{"ok":false,"db":"down"}' })).toEqual({
      type: 'HEALTH_OK',
      db: 'down',
    })
  })

  it('gateway：200 但 ok 非 true → 失败（诚实）', () => {
    expect(healthResultToEvent('gateway', { status: 200, body: '{"ok":false}' })).toMatchObject({
      type: 'HEALTH_FAIL',
    })
  })

  it('gateway：非 JSON → 失败', () => {
    expect(healthResultToEvent('gateway', { status: 200, body: '<html>' })).toMatchObject({
      type: 'HEALTH_FAIL',
    })
  })

  it('console：任何 2xx → HEALTH_OK（db unknown）', () => {
    expect(healthResultToEvent('console', { status: 200, body: '<!doctype html>...' })).toEqual({
      type: 'HEALTH_OK',
      db: 'unknown',
    })
    expect(healthResultToEvent('console', { status: 204, body: '' })).toEqual({
      type: 'HEALTH_OK',
      db: 'unknown',
    })
  })

  it('pg：TCP 探针（2xx=端口 accept）→ HEALTH_OK db unknown；无监听 → FAIL', () => {
    expect(healthResultToEvent('pg', { status: 200, body: '' })).toEqual({
      type: 'HEALTH_OK',
      db: 'unknown',
    })
    expect(healthResultToEvent('pg', { error: 'TCP 127.0.0.1:55432 无监听' })).toMatchObject({
      type: 'HEALTH_FAIL',
    })
  })

  it('console：非 2xx / 网络错 → HEALTH_FAIL', () => {
    expect(healthResultToEvent('console', { status: 500, body: '' })).toMatchObject({ type: 'HEALTH_FAIL' })
    expect(healthResultToEvent('console', { error: 'ECONNREFUSED' })).toEqual({
      type: 'HEALTH_FAIL',
      error: 'ECONNREFUSED',
    })
  })

  it('healthUrl：gateway /health、console 根路径', () => {
    expect(healthUrl('gateway', 8080)).toBe('http://localhost:8080/health')
    expect(healthUrl('console', 3000)).toBe('http://localhost:3000/')
  })
})

describe('ServiceSupervisor', () => {
  it('spawn 路径：start → spawn(默认命令+repoRoot cwd) → 健康轮询 → running', async () => {
    const world = new FakeWorld()
    const sup = makeSup('gateway', world)
    world.httpQueue = [
      { error: 'ECONNREFUSED' }, // 启动期首探失败正常
      { status: 200, body: '{"ok":true,"db":"up"}' },
    ]
    await sup.start()
    // spawn 同步完成（child_process.spawn 立即返回句柄）→ 已进 waiting_health
    expect(sup.state).toBe('waiting_health')
    expect(world.spawnedSpecs).toEqual([
      {
        id: 'gateway',
        command: 'pnpm',
        args: ['--filter', '@dagents/gateway', 'dev'],
        cwd: 'C:/repo',
        env: {},
      },
    ])
    await world.advance(10) // SPAWNED → 0ms 后首次轮询
    expect(sup.state).toBe('waiting_health')
    await world.advance(600) // 下一轮轮询吃到 ok
    expect(sup.state).toBe('running')
    expect(sup.status.db).toBe('up')
  })

  it('附加路径：端口已听 → 不 spawn，直接 waiting_health(attachMode) → running', async () => {
    const world = new FakeWorld()
    world.openPorts.add(8080)
    world.httpQueue = [{ status: 200, body: '{"ok":true,"db":"up"}' }]
    const sup = makeSup('gateway', world)
    await sup.start()
    expect(world.spawnedSpecs).toEqual([])
    expect(sup.status.attachMode).toBe(true)
    expect(sup.state).toBe('waiting_health')
    await world.advance(10)
    expect(sup.state).toBe('running')
  })

  it('子进程退出 → 退避 1s 后重启（真定时器语义）', async () => {
    const world = new FakeWorld()
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: '{"ok":true,"db":"up"}' },
    ]
    const sup = makeSup('console', world)
    await sup.start()
    await world.advance(10)
    await world.advance(600)
    expect(sup.state).toBe('running')

    world.spawnHandles[0].markExited(1)
    expect(sup.state).toBe('restarting')
    expect(sup.status.attempts).toBe(1)
    expect(world.timers.size).toBeGreaterThan(0)

    await world.advance(1_000) // 退避 1s 到期 → RESTART_DUE → 再 spawn → 立即轮询吃到 ok → running
    expect(sup.state).toBe('running')
    expect(world.spawnedSpecs).toHaveLength(2)
  })

  it('健康持续失败超过 healthTimeoutMs → kill-tree + 进重启预算', async () => {
    const world = new FakeWorld()
    const sup = makeSup('gateway', world)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' }, // 先 running
    ]
    for (let i = 0; i < 300; i++) world.httpQueue.push({ error: 'ECONNREFUSED' })
    await sup.start()
    await world.advance(10)
    await world.advance(600)
    expect(sup.state).toBe('running')

    // 轮询节拍 5s，持续失败 120s → 超时（advance 分步推进让定时器链继续）
    await world.advance(10_000)
    await world.advance(30_000)
    await world.advance(40_000)
    await world.advance(45_000)
    expect(sup.state).toBe('restarting')
    expect(world.killedPids).toContain(world.spawnHandles[0].pid)
  })

  it('db:down（503）→ running + degraded 文案，不重启', async () => {
    const world = new FakeWorld()
    const sup = makeSup('gateway', world)
    world.httpQueue = [{ status: 503, body: '{"ok":false,"svc":"gateway","db":"down"}' }]
    await sup.start()
    await world.advance(10)
    expect(sup.state).toBe('running')
    expect(sup.status.db).toBe('down')
    expect(sup.status.message).toContain('docker compose up')
    expect(world.killedPids).toEqual([])
  })

  it('stop：树终止 + 定时器清空；后续轮询不再触发', async () => {
    const world = new FakeWorld()
    const sup = makeSup('gateway', world)
    world.httpQueue = [{ status: 200, body: '{"ok":true,"db":"up"}' }]
    await sup.start()
    await world.advance(10)
    await world.advance(600)
    expect(sup.state).toBe('running')

    sup.stop()
    expect(sup.state).toBe('stopped')
    expect(world.killedPids).toEqual([world.spawnHandles[0].pid])
    await world.advance(30_000)
    expect(world.timers.size).toBe(0) // 停止后无任何遗留定时器
    // stopped 后状态不再漂移
    expect(sup.state).toBe('stopped')
  })

  it('spawn 抛错 → failed + 引导文案', async () => {
    const world = new FakeWorld()
    const throwingDeps = { ...world.deps, spawnService: () => {
      throw new Error('spawn pnpm ENOENT')
    } }
    const sup = new ServiceSupervisor('gateway', throwingDeps, defaultConfig('C:/r'), () => {})
    await sup.start()
    expect(sup.state).toBe('failed')
    expect(sup.status.message).toContain('ENOENT')
  })

  it('stdout/stderr 按行进日志', async () => {
    const world = new FakeWorld()
    const sup = makeSup('console', world)
    world.httpQueue = [{ status: 200, body: 'ok' }]
    await sup.start()
    world.spawnHandles[0].emitStdout('hello\nworld\n')
    world.spawnHandles[0].emitStderr('warn')
    expect(world.logs.console).toContainEqual(expect.stringContaining('[stdout] hello'))
    expect(world.logs.console.filter((l) => l.includes('[stdout] world'))).toHaveLength(1)
    expect(world.logs.console.some((l) => l.includes('[stderr] warn'))).toBe(true)
  })
})

describe('computePhase（就绪接管判定——db down 不接管）', () => {
  const svc = (over: Partial<ServiceStatus>): ServiceStatus => ({
    id: 'gateway',
    state: 'running',
    attachMode: false,
    db: 'up',
    attempts: 0,
    lastExit: null,
    startedAt: 1,
    message: null,
    ...over,
  })

  it('双健康 → console（含附加模式：state 一样是 running）', () => {
    expect(computePhase(svc({}), svc({ id: 'console' }))).toBe('console')
    expect(computePhase(svc({ attachMode: true }), svc({ id: 'console', attachMode: true }))).toBe(
      'console'
    )
  })

  it('gateway db:down（降级）→ boot——不接管，留在启动态页看引导', () => {
    expect(computePhase(svc({ db: 'down' }), svc({ id: 'console' }))).toBe('boot')
  })

  it('gateway 非 running（restarting/failed/waiting…）→ boot', () => {
    for (const state of ['restarting', 'failed', 'waiting_health', 'stopped', 'starting'] as const) {
      expect(computePhase(svc({ state }), svc({ id: 'console' }))).toBe('boot')
    }
  })

  it('console 非 running → boot（崩溃回退启动态页的判定源）', () => {
    for (const state of ['restarting', 'failed', 'waiting_health', 'stopped'] as const) {
      expect(computePhase(svc({}), svc({ id: 'console', state }))).toBe('boot')
    }
  })
})

describe('Orchestrator 门面', () => {
  /** 双服务焦点用例的配置：关内嵌 PG（pg 管线有自己的用例组）。 */
  function twoServiceConfig() {
    const cfg = defaultConfig('C:/repo')
    cfg.postgres.embedded = false
    return cfg
  }

  it('snapshot 含双服务状态/日志尾/配置投影；onChange 触发订阅者', async () => {
    const world = new FakeWorld()
    const orch = new Orchestrator(twoServiceConfig(), world.deps)
    const events: number[] = []
    orch.onChange(() => events.push(1))
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: 'ok' },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)
    const snap = orch.snapshot()
    expect(snap.phase).toBe('console') // 双健康（gateway ok:true + console 200）→ 接管
    expect(snap.services.gateway.state).toBe('running')
    expect(snap.services.console.state).toBe('running')
    expect(snap.config.gatewayPort).toBe(8080)
    expect(snap.config.consolePort).toBe(3000)
    expect(snap.config.repoRoot).toBe('C:/repo')
    expect(events.length).toBeGreaterThan(0)
  })

  it('stopAll 杀树并确认端口释放；端口仍占 → 报告 false（告警路径）', async () => {
    const world = new FakeWorld()
    const orch = new Orchestrator(twoServiceConfig(), world.deps)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: 'ok' },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)

    // 模拟「外部别的进程占着 3000」：kill 后端口仍开
    world.openPorts.add(3000)
    const stopPromise = orch.stopAll()
    // stopAll 的 setTimer(1500) 在首个 isPortOpen 微任务之后才注册——分轮推进假时钟
    await world.advance(100)
    await world.advance(2_000)
    await world.advance(100)
    const report = await stopPromise
    expect(report.gateway).toBe(true)
    expect(report.console).toBe(false) // 仍被占 → false + 告警日志
    expect(world.logs.console.some((l) => l.includes('仍被占用'))).toBe(true)
    expect(world.killedPids.length).toBe(2) // 两棵树都终止了
  })

  it('restartAll：停 → 起双服务', async () => {
    const world = new FakeWorld()
    const orch = new Orchestrator(twoServiceConfig(), world.deps)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: 'ok' },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)
    await orch.restartAll()
    // 停净后重启：spawn 同步完成 → waiting_health，且累计双服务 × 两轮 spawn
    expect(orch.snapshot().services.gateway.state).toBe('waiting_health')
    expect(world.spawnedSpecs.length).toBeGreaterThanOrEqual(4)
  })
})

describe('内嵌 PG 编排（M5，docs §10.2）', () => {
  // fake fs 的 key 必须与被测代码 join() 的输出同构（win32 反斜杠）
  const PG_BIN = join('C:/stage/pg/native/bin', 'postgres.exe')
  const DATA_DIR = 'C:/ud/pgdata'
  const pgPaths = {
    binDir: 'C:/stage/pg/native/bin',
    dataDir: DATA_DIR,
    migrateScript: 'C:/repo/packages/db/scripts/migrate.mjs',
    pgRequireRoot: 'C:/repo/packages/db',
  }

  function makeWorld() {
    const world = new FakeWorld()
    // 二进制在位；dataDir 无 PG_VERSION → 首启走 initdb（runOnce 队列第 1 项）
    world.files.set(PG_BIN, 'binary')
    world.runOnceQueue = [
      { code: 0, stdout: 'initdb: ok' }, // initdb
      { code: 0, stdout: 'db: applied Init' }, // migrate
      // pg_ctl stop：副作用 = postgres 进程退出、端口释放（fake 世界的物理事实）
      {
        code: 0,
        stdout: 'server stopped',
        effect: () => {
          if (world.pgSpawnPort !== null) world.openPorts.delete(world.pgSpawnPort)
        },
      },
    ]
    return world
  }

  it('全链路：initdb → postgres 前台直跑 → TCP 健康 → 建库 → 迁移 → gateway 注入 DSN → 双健康', async () => {
    const world = makeWorld()
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' }, // gateway
      { status: 200, body: '<!doctype html>' }, // console
    ]
    orch.start()
    await world.advance(10) // pg spawn + 首轮 TCP 探活 → running
    await world.advance(500) // waitUntilSettled + 建库 + 迁移 + gateway/console spawn + 健康

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('running')
    expect(snap.services.gateway.state).toBe('running')
    expect(snap.services.gateway.db).toBe('up')
    expect(snap.phase).toBe('console') // 端到端：gateway db:up（内含 pg 语义）
    expect(snap.config.pgPort).toBe(55432)
    expect(snap.config.pgEmbedded).toBe(true)
    expect(snap.config.pgDataDir).toBe(DATA_DIR)

    // pg spawn 形态：前台直跑 postgres -D <data> -p 55432 -h 127.0.0.1
    const pgSpawn = world.spawnedSpecs.find((s) => s.id === 'pg')
    expect(pgSpawn?.command).toBe(PG_BIN)
    expect(pgSpawn?.args).toEqual(['-D', DATA_DIR, '-p', '55432', '-h', '127.0.0.1'])

    // bootstrap 顺序：initdb → migrate（runOnce 各一次）
    const commands = world.runOnceSpecs.map((s) => s.command)
    expect(commands[0]).toContain('initdb')
    expect(commands[1]).toContain('node')
    expect(world.runOnceSpecs[1].env?.POSTGRES_URL).toBe('postgresql://dagents@127.0.0.1:55432/dagents')

    // gateway env 注入内嵌 DSN（extraEnv 通道）
    const gwSpawn = world.spawnedSpecs.find((s) => s.id === 'gateway')
    expect(gwSpawn?.env?.POSTGRES_URL).toBe('postgresql://dagents@127.0.0.1:55432/dagents')

    // 建库查询走了维护库
    expect(world.pgQueries.some((q) => q.includes('pg_database'))).toBe(true)
  })

  it('端口让位：55432 被占 → 55433，DSN/状态明示', async () => {
    const world = makeWorld()
    world.openPorts.add(55432) // 外部占用默认端口
    world.runOnceQueue[1] = { code: 0, stdout: 'db: applied' }
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: 'ok' },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('running')
    expect(snap.config.pgPort).toBe(55433)
    // pg spawn 用让位端口；DSN 同步
    const pgSpawn = world.spawnedSpecs.find((s) => s.id === 'pg')
    expect(pgSpawn?.args).toContain('55433')
    expect(world.runOnceSpecs[1].env?.POSTGRES_URL).toBe('postgresql://dagents@127.0.0.1:55433/dagents')
    // 状态明示（docs §10.3：实际端口写状态页）
    expect(snap.services.pg.message).toContain('55432')
    expect(snap.services.pg.message).toContain('55433')
    expect(world.logs.pg.some((l) => l.includes('让位'))).toBe(true)
  })

  it('迁移失败 → pg failed + gateway 不启动（docker-entrypoint 语义）', async () => {
    const world = makeWorld()
    world.runOnceQueue[1] = { code: 1, stderr: 'TypeError: cannot read migrations' }
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps, { pgPaths })
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('failed')
    expect(snap.services.pg.message).toContain('迁移失败')
    expect(world.spawnedSpecs.some((s) => s.id === 'gateway')).toBe(false)
    expect(world.spawnedSpecs.some((s) => s.id === 'console')).toBe(false)
    expect(snap.phase).toBe('boot')
  })

  it('附加模式（8080 已监听）→ 内嵌 PG 不启动，诚实标记', async () => {
    const world = makeWorld()
    world.openPorts.add(8080) // 外部 gateway 实例
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps, { pgPaths })
    world.httpQueue = [{ status: 200, body: '{"ok":true,"db":"up"}' }]
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('idle')
    expect(snap.services.pg.message).toContain('附加模式')
    expect(world.spawnedSpecs.some((s) => s.id === 'pg')).toBe(false)
    expect(world.runOnceSpecs).toEqual([]) // initdb 也没跑
    expect(snap.services.gateway.attachMode).toBe(true) // gateway 附加语义原样
    expect(snap.config.pgPort).toBe(null)
  })

  it('stopAll：console→gateway→pg 顺序，pg_ctl fast 优先 + EXIT 抑制不触发重启', async () => {
    const world = makeWorld()
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: 'ok' },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(500)
    expect(orch.snapshot().phase).toBe('console')

    const stopPromise = orch.stopAll()
    await world.advance(100)
    await world.advance(2_000)
    await world.advance(100)
    const report = await stopPromise

    expect(report.gateway).toBe(true)
    expect(report.console).toBe(true)
    expect(report.pg).toBe(true)
    // pg_ctl stop -m fast -w -t 5 被调用
    const ctl = world.runOnceSpecs.find((s) => s.command.includes('pg_ctl'))
    expect(ctl?.args).toEqual(['-D', DATA_DIR, '-m', 'fast', '-w', '-t', '5', 'stop'])
    // postgres 树被兜底终止（suppressExit 之后 stop 的 kill-tree）
    expect(world.killedPids.length).toBe(3)
    // 停净后端口全释放、pg 未进重启链（suppressExit 生效——attempts 保持 0）
    expect(world.openPorts.has(55432)).toBe(false)
    const pgStatus = orch.snapshot().services.pg
    expect(pgStatus.state).toBe('stopped')
    expect(pgStatus.attempts).toBe(0)
    expect(world.logs.pg.some((l) => l.includes('优雅停止流程中，不触发重启'))).toBe(true)
  })
})
