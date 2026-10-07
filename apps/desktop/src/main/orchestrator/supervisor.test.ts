import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { defaultConfig } from './config'
import { probeUrl } from './identity'
import type { PgClient, PgDeps, RunOnceSpec } from './pg-service'
import {
  computePhase,
  healthResultToEvent,
  Orchestrator,
  ServiceSupervisor,
  type HttpResult,
  type SpawnHandle,
} from './supervisor'
import type { ServiceId, ServiceStatus } from './types'

// supervisor 单测：假时钟/假 HTTP/假 spawn 全速驱动（docs §6 编排器核心场景 +
// §18 端口计划接线），不碰真进程真网络——真子进程树终止与真端口探测在
// tree-kill.test.ts / ports.test.ts。
// M5 起 FakeWorld 同时实现 PgDeps（runOnce/connectPg/假文件系统）驱动内嵌 PG 管线；
// M8 起 httpGet 按超时参数分流：身份问询（10s，port-plan 发起）走 identityQueue，
// 健康轮询（4s）走 httpQueue——两通道互不抢答。

/** console 首页 dagents 形状（身份判别 + 健康判活共用，§18.3）。 */
const DAGENTS_HTML = '<!doctype html><html><head><title>Dagents</title></head></html>'

/** 假世界：手动时钟 + 定时器队列 + 可编排的 HTTP 应答队列 + spawn 记录。 */
class FakeWorld {
  now = 1_000_000
  timers = new Map<number, { cb: () => void; at: number }>()
  private timerSeq = 1
  logs: Record<ServiceId, string[]> = { gateway: [], console: [], pg: [] }
  httpQueue: HttpResult[] = []
  /** 身份问询应答队列（端口被占时 port-plan 消费；空则视 stranger 的 error 应答）。 */
  identityQueue: HttpResult[] = []
  httpRequests: string[] = []
  identityRequests: string[] = []
  /** 端口占用集合（附加模式 / 让位测试的开关）。 */
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
      // 身份问询（10s 超时，docs §18.3）与健康轮询（4s）按超时分流
      if (timeoutMs >= 10_000) {
        this.identityRequests.push(url)
        const next = this.identityQueue.shift()
        return next ?? { error: 'TimeoutError (identity queue empty → stranger)' }
      }
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

/** 平台无关绝对路径根（遗留债①：isAbsolute/join 语义两平台同真）。 */
const ROOT = resolve('/')
/** pg 夹具路径（两个 PG describe 共用）。 */
const PG_ROOT = join(ROOT, 'stage', 'pg', 'native', 'bin')
const DATA_DIR = join(ROOT, 'ud', 'pgdata')

function makeSup(id: ServiceId, world: FakeWorld) {
  return new ServiceSupervisor(id, world.deps, defaultConfig(join(ROOT, 'repo')), () => {})
}

describe('healthResultToEvent（判活协议 docs §3.1 + §18.3 console 身份特征）', () => {
  it('gateway：200+ok:true → HEALTH_OK up', () => {
    expect(healthResultToEvent('gateway', { status: 200, body: '{"ok":true,"db":"up"}' })).toEqual({
      type: 'HEALTH_OK',
      db: 'up',
    })
  })

  it('gateway：503+db:down → HEALTH_OK down（进程活着，DB 未就绪——不重启）', () => {
    expect(healthResultToEvent('gateway', { status: 503, body: '{"ok":false,"svc":"gateway","db":"down"}' })).toEqual({
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

  it('console：2xx + title Dagents → HEALTH_OK（db unknown）', () => {
    expect(healthResultToEvent('console', { status: 200, body: DAGENTS_HTML })).toEqual({
      type: 'HEALTH_OK',
      db: 'unknown',
    })
  })

  it('console：2xx 但 title 非 Dagents（陌生 web 服务占端口）→ HEALTH_FAIL（病灶②收口）', () => {
    expect(healthResultToEvent('console', { status: 200, body: '<title>Vite + TS</title>' })).toMatchObject({
      type: 'HEALTH_FAIL',
    })
    expect(healthResultToEvent('console', { status: 204, body: '' })).toMatchObject({
      type: 'HEALTH_FAIL',
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

  it('probeUrl：gateway /health、console 根路径（身份问询与健康探测同面）', () => {
    expect(probeUrl('gateway', 8080)).toBe('http://localhost:8080/health')
    expect(probeUrl('console', 3000)).toBe('http://localhost:3000/')
  })
})

describe('ServiceSupervisor', () => {
  it('spawn 路径：start → spawn(默认命令+repoRoot cwd+计划端口 env) → 健康轮询 → running', async () => {
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
        cwd: join(ROOT, 'repo'),
        // 裸 supervisor 走默认 runSpec（extraEnv 通道）；计划端口 env（GATEWAY_PORT）
        // 由 Orchestrator.buildRunSpec 注入——该面在下方 Orchestrator 用例断言
        env: {},
      },
    ])
    await world.advance(10) // SPAWNED → 0ms 后首次轮询
    expect(sup.state).toBe('waiting_health')
    await world.advance(600) // 下一轮轮询吃到 ok
    expect(sup.state).toBe('running')
    expect(sup.status.db).toBe('up')
  })

  it('附加路径：start({attach:true}) 指令 → 不 spawn，直接 waiting_health(attachMode) → running', async () => {
    const world = new FakeWorld()
    world.openPorts.add(8080)
    world.httpQueue = [{ status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' }]
    const sup = makeSup('gateway', world)
    // 附加判定已上移 port-plan（身份判别）；supervisor 只按指令落地（§18.2）
    await sup.start({ attach: true })
    expect(world.spawnedSpecs).toEqual([])
    expect(sup.status.attachMode).toBe(true)
    expect(sup.state).toBe('waiting_health')
    await world.advance(10)
    expect(sup.state).toBe('running')
  })

  it('端口计划失败 → failPlacement：idle 直接 failed，文案直载 reason', () => {
    const world = new FakeWorld()
    const sup = makeSup('console', world)
    sup.failPlacement('dev 形态固定端口 3000 被非 dagents 程序占用——不让位')
    expect(sup.state).toBe('failed')
    expect(sup.status.message).toContain('端口分配失败')
    expect(sup.status.message).toContain('不让位')
    expect(world.spawnedSpecs).toEqual([])
    expect(world.logs.console.some((l) => l.includes('非 dagents'))).toBe(false) // 不经 spawn
  })

  it('子进程退出 → 退避 1s 后重启（真定时器语义）', async () => {
    const world = new FakeWorld()
    world.httpQueue = [
      { status: 200, body: DAGENTS_HTML },
      { status: 200, body: DAGENTS_HTML },
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
    const cfg = defaultConfig(join(ROOT, 'repo'))
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
      { status: 200, body: DAGENTS_HTML },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)
    const snap = orch.snapshot()
    expect(snap.phase).toBe('console') // 双健康（gateway ok:true + console title Dagents）→ 接管
    expect(snap.services.gateway.state).toBe('running')
    expect(snap.services.console.state).toBe('running')
    expect(snap.config.gatewayPort).toBe(8080)
    expect(snap.config.consolePort).toBe(3000)
    expect(snap.config.consoleUrl).toBe('http://localhost:3000') // 计划派生（§18.2）
    expect(snap.config.repoRoot).toBe(join(ROOT, 'repo'))
    expect(events.length).toBeGreaterThan(0)
  })

  it('stopAll 杀树并确认端口释放；端口仍占 → 报告 false（告警路径）', async () => {
    const world = new FakeWorld()
    const orch = new Orchestrator(twoServiceConfig(), world.deps)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
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

  it('restartAll：停 → 起双服务（重求端口计划）', async () => {
    const world = new FakeWorld()
    const orch = new Orchestrator(twoServiceConfig(), world.deps)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)
    await orch.restartAll()
    // 停净后重启：spawn 同步完成 → waiting_health，且累计双服务 × 两轮 spawn
    expect(orch.snapshot().services.gateway.state).toBe('waiting_health')
    expect(world.spawnedSpecs.length).toBeGreaterThanOrEqual(4)
  })

  it('restartAll 重探测：让位过的端口腾出后回到默认端口（§18.6 自愈入口）', async () => {
    const world = new FakeWorld()
    const cfg = twoServiceConfig()
    const orch = new Orchestrator(cfg, world.deps, { runMode: 'packaged' })
    world.openPorts.add(3000) // 陌生程序占 3000
    world.identityQueue = [{ status: 200, body: '<title>Vite + TS</title>' }] // console 身份=陌生
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML }, // 让位 3001 上的 console 健康
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)
    expect(orch.snapshot().config.consolePort).toBe(3001)

    // 占用者退场 → restartAll 重求计划 → 回默认 3000
    world.openPorts.delete(3000)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    await orch.restartAll()
    await world.advance(10)
    await world.advance(600)
    const snap = orch.snapshot()
    expect(snap.config.consolePort).toBe(3000)
    expect(snap.services.console.state).toBe('running')
  })

  it('探测-绑定竞态自愈（§18.6 全链）：让位端口被抢→bind 失败有界重试→耗尽诚实 failed→restartAll 重求 plan 恢复', async () => {
    const world = new FakeWorld()
    const cfg = twoServiceConfig()
    const realSpawn = world.deps.spawnService.bind(world.deps)
    const realHttpGet = world.deps.httpGet.bind(world.deps)
    let raceActive = true // 探测后抢注开关（耗尽判死后关掉再走恢复）
    let consoleSpawns = 0
    // 竞态模拟：console 每次 spawn 紧跟「外部抢注 3001 + 子进程退出」——
    // bind EADDRINUSE 即退出的物理事实（§18.10 #3 实测竞态窗口存在）
    world.deps.spawnService = (id, spec) => {
      const handle = realSpawn(id, spec)
      if (id === 'console' && raceActive) {
        consoleSpawns++
        world.openPorts.add(3001)
        queueMicrotask(() => (handle as FakeSpawnHandle).markExited(1))
      }
      return handle
    }
    // 健康路由：gateway 恒健康；console 健康按 3001 占用状态分叉（抢注者是陌生 web 服务）
    world.deps.httpGet = async (url, timeoutMs) => {
      if (timeoutMs >= 10_000) return { status: 200, body: '<title>Vite + TS</title>' } // 身份问询恒陌生
      if (url.includes('/health')) return { status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' }
      if (url.endsWith(':3001/')) {
        return world.openPorts.has(3001)
          ? { status: 200, body: '<title>SomeOtherApp</title>' }
          : { status: 200, body: DAGENTS_HTML }
      }
      return realHttpGet(url, timeoutMs)
    }

    const orch = new Orchestrator(cfg, world.deps, { runMode: 'packaged' })
    world.openPorts.add(3000) // 陌生程序占默认 → 计划让位 3001
    orch.start()
    await world.advance(10)
    await world.advance(25_000) // 退避 1/3/9s × 3 次重启全部耗尽（§3.2 有界语义）

    const failed = orch.snapshot()
    expect(failed.config.consoleYielded).toBe(true) // 计划曾让位（快照如实）
    expect(failed.services.console.state).toBe('failed') // 预算耗尽诚实 failed
    expect(failed.services.console.message).toContain('预算耗尽')
    expect(consoleSpawns).toBe(4) // 初次 + 3 次重启，第 4 次退出后判死（不无限重试）
    expect(failed.services.gateway.state).toBe('running') // gateway 不受牵连

    // 一键重启（菜单「重启服务」通道）：抢占者退场 → 重求 plan → 让位 3001 自起恢复
    raceActive = false
    world.openPorts.delete(3001)
    await orch.restartAll()
    await world.advance(10)
    await world.advance(600)
    const recovered = orch.snapshot()
    expect(recovered.services.console.state).toBe('running')
    expect(recovered.config.consolePort).toBe(3001) // 3000 仍被占 → 依旧让位 3001
    expect(recovered.phase).toBe('console') // 双健康恢复接管
  })
})

describe('内嵌 PG 编排（M5，docs §10.2 + §18 端口计划）', () => {
  // fake fs 的 key 与被测代码 platformExe()/join() 输出同构（平台无关，遗留债①）
  const PG_BIN = join(PG_ROOT, process.platform === 'win32' ? 'postgres.exe' : 'postgres')
  const pgPaths = {
    binDir: PG_ROOT,
    dataDir: DATA_DIR,
    migrateScript: join(ROOT, 'repo', 'packages', 'db', 'scripts', 'migrate.mjs'),
    pgRequireRoot: join(ROOT, 'repo', 'packages', 'db'),
    nodeRuntime: { command: 'node', env: {} },
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

  /** dev 形态显式启用内嵌 PG：AC-7④ 豁免条件（embedded 与 embeddedExplicit 同置）。 */
  function embeddedPgConfig() {
    const cfg = defaultConfig(join(ROOT, 'repo'))
    cfg.postgres.embedded = true
    cfg.postgres.embeddedExplicit = true
    return cfg
  }

  it('dev 默认不启用内嵌 PG（AC-7④）：未显式 embedded → pg skipped + gateway 不注入 DSN', async () => {
    const world = makeWorld()
    // defaultConfig + 不传 runMode（缺省 dev）+ embedded 未显式 → 门控默认关
    const orch = new Orchestrator(defaultConfig(join(ROOT, 'repo')), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' }, // gateway（外部库就绪语义）
      { status: 200, body: DAGENTS_HTML }, // console
    ]
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('idle')
    expect(snap.services.pg.message).toContain('外部 Postgres')
    expect(snap.config.pgEmbedded).toBe(false)
    // 不 spawn pg、bootstrap 零步（initdb/迁移未跑）、gateway env 不注入内嵌 DSN
    expect(world.spawnedSpecs.some((s) => s.id === 'pg')).toBe(false)
    expect(world.runOnceSpecs).toEqual([])
    const gwSpawn = world.spawnedSpecs.find((s) => s.id === 'gateway')
    expect(gwSpawn?.env?.POSTGRES_URL).toBeUndefined()
    expect(gwSpawn?.env?.GATEWAY_PORT).toBe('8080') // dev 形态同源注入（§18.4）
    expect(world.logs.pg.some((l) => l.includes('dev 模式默认不启用'))).toBe(true)
    expect(snap.phase).toBe('console') // 外部库语义下双健康照常接管
  })

  it('dev 形态父环境全量继承（2026-10-07 真机缺陷：极简 env 致 gateway 内 spawn CLI agent ENOENT）', async () => {
    const world = makeWorld()
    const orch = new Orchestrator(defaultConfig(join(ROOT, 'repo')), world.deps, {
      pgPaths,
      parentEnv: {
        PATH: 'C:/Windows/system32;C:/Users/u/AppData/Local/hermes/bin',
        SYSTEMROOT: 'C:/Windows',
        POSTGRES_URL: 'postgresql://parent@127.0.0.1:9999/parent',
      },
    })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const gwSpawn = world.spawnedSpecs.find((s) => s.id === 'gateway')
    const csSpawn = world.spawnedSpecs.find((s) => s.id === 'console')
    // PATH/SYSTEMROOT 必须进服务子进程（gateway 内 spawn claude/hermes 的前提）
    expect(gwSpawn?.env?.PATH).toBe('C:/Windows/system32;C:/Users/u/AppData/Local/hermes/bin')
    expect(gwSpawn?.env?.SYSTEMROOT).toBe('C:/Windows')
    expect(csSpawn?.env?.PATH).toBe('C:/Windows/system32;C:/Users/u/AppData/Local/hermes/bin')
    // 注入链键仍胜出：GATEWAY_PORT/PORT 来自计划，POSTGRES_URL 未被父环境抢占
    //（gatewayEnv 在 pg bootstrap 后追加，父环境的同名键不得越过注入链）
    expect(gwSpawn?.env?.GATEWAY_PORT).toBe('8080')
    expect(csSpawn?.env?.PORT).toBe('3000')
  })

  it('全链路：计划 → initdb → postgres 前台直跑 → TCP 健康 → 建库 → 迁移 → gateway 注入 DSN → 双健康', async () => {
    const world = makeWorld()
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' }, // gateway
      { status: 200, body: DAGENTS_HTML }, // console
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

    // gateway env 注入内嵌 DSN + 计划端口（extraEnv 通道）
    const gwSpawn = world.spawnedSpecs.find((s) => s.id === 'gateway')
    expect(gwSpawn?.env?.POSTGRES_URL).toBe('postgresql://dagents@127.0.0.1:55432/dagents')
    expect(gwSpawn?.env?.GATEWAY_PORT).toBe('8080')

    // console env：计划端口 + BFF gateway 地址（同源注入）
    const csSpawn = world.spawnedSpecs.find((s) => s.id === 'console')
    expect(csSpawn?.env?.PORT).toBe('3000')
    expect(csSpawn?.env?.GATEWAY_URL).toBe('http://localhost:8080')

    // 建库查询走了维护库
    expect(world.pgQueries.some((q) => q.includes('pg_database'))).toBe(true)
  })

  it('端口让位（packaged）：55432 被占 → 55433，DSN/状态明示', async () => {
    const world = makeWorld()
    world.openPorts.add(55432) // 外部占用默认端口
    world.runOnceQueue[1] = { code: 0, stdout: 'db: applied' }
    // 让位仅 packaged 形态（dev 固定端口不让位，§18.4）
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths, runMode: 'packaged' })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
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

  it('dev 形态 55432 被占 → 内嵌 PG 诚实 failed（固定端口纪律，§18.4）', async () => {
    const world = makeWorld()
    world.openPorts.add(55432)
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths }) // 缺省 dev
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('failed')
    expect(snap.services.pg.message).toContain('不让位')
    expect(world.spawnedSpecs.some((s) => s.id === 'pg')).toBe(false)
    expect(world.spawnedSpecs.some((s) => s.id === 'gateway')).toBe(false) // pg 失败 → gateway 不启动
  })

  it('迁移失败 → pg failed + gateway 不启动（docker-entrypoint 语义）', async () => {
    const world = makeWorld()
    world.runOnceQueue[1] = { code: 1, stderr: 'TypeError: cannot read migrations' }
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths })
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

  it('附加模式（8080 是真 dagents）→ 不 spawn gateway/pg，身份判别放行', async () => {
    const world = makeWorld()
    world.openPorts.add(8080) // 外部 gateway 实例
    world.identityQueue = [{ status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' }]
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths })
    world.httpQueue = [{ status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' }]
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.pg.state).toBe('idle')
    expect(snap.services.pg.message).toContain('附加模式')
    expect(world.spawnedSpecs.some((s) => s.id === 'pg')).toBe(false)
    expect(world.runOnceSpecs).toEqual([]) // initdb 也没跑
    expect(snap.services.gateway.attachMode).toBe(true) // gateway 附加语义原样
    expect(world.spawnedSpecs.some((s) => s.id === 'gateway')).toBe(false) // 不 spawn
    expect(snap.config.pgPort).toBe(null)
    // M9：附加态服务卡 message 铺设计划附加说明（decoratePlacement）
    expect(snap.services.gateway.state).toBe('running')
    expect(snap.services.gateway.message).toContain('附加模式')
    expect(snap.services.gateway.message).toContain('不代杀')
    // 身份问询确实发生（10s 通道）且问的是 /health
    expect(world.identityRequests).toEqual(['http://localhost:8080/health'])
  })

  it('附加端口是陌生程序（8080 无 svc）→ dev 诚实 failed，pg skipped，console 不起', async () => {
    const world = makeWorld()
    world.openPorts.add(8080)
    world.identityQueue = [{ status: 200, body: '{"ok":true}' }] // 盲附加病灶形态
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths }) // 缺省 dev
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.services.gateway.state).toBe('failed')
    expect(snap.services.gateway.message).toContain('端口分配失败')
    expect(snap.services.gateway.message).toContain('dev 形态固定端口 8080')
    expect(snap.services.gateway.attachMode).toBe(false) // 不再盲附加
    expect(snap.services.pg.state).toBe('idle')
    expect(snap.services.pg.message).toContain('gateway 端口分配失败')
    expect(snap.services.console.state).toBe('idle') // 下游不启动
    expect(world.spawnedSpecs).toEqual([]) // 全栈零 spawn
  })

  it('stopAll：console→gateway→pg 顺序，pg_ctl fast 优先 + EXIT 抑制不触发重启', async () => {
    const world = makeWorld()
    const orch = new Orchestrator(embeddedPgConfig(), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
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

  it('stopAll 附加态：外部实例端口不校验不误报（退出不代杀语义）', async () => {
    const world = makeWorld()
    world.openPorts.add(8080)
    world.openPorts.add(3000)
    world.identityQueue = [
      { status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    const orch = new Orchestrator(twoServiceAttachConfig(), world.deps, { pgPaths })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)
    expect(orch.snapshot().phase).toBe('console') // 双附加双健康

    const stopPromise = orch.stopAll()
    await world.advance(100)
    const report = await stopPromise
    expect(report.gateway).toBe(true)
    expect(report.console).toBe(true)
    // 外部实例仍占着端口（我们不杀）——但不再误报「仍被占用」
    expect(world.openPorts.has(8080)).toBe(true)
    expect(world.openPorts.has(3000)).toBe(true)
    expect(world.logs.gateway.some((l) => l.includes('仍被占用'))).toBe(false)
    expect(world.logs.console.some((l) => l.includes('仍被占用'))).toBe(false)
    expect(world.killedPids).toEqual([]) // 附加态无 pid 天然不杀
  })
})

/** 附加场景配置：pg 不嵌入（外部栈语义）。 */
function twoServiceAttachConfig() {
  const cfg = defaultConfig(join(ROOT, 'repo'))
  cfg.postgres.embedded = false
  return cfg
}

describe('packaged 编排（M6，docs §11.4 + §18.2 计划注入）', () => {
  const PG_BIN = join(PG_ROOT, process.platform === 'win32' ? 'postgres.exe' : 'postgres')
  const APP = join(ROOT, 'app')
  const pgPaths = {
    binDir: PG_ROOT,
    dataDir: DATA_DIR,
    migrateScript: join(APP, 'services', 'gateway', 'node_modules', '@dagents', 'db', 'scripts', 'migrate.mjs'),
    pgRequireRoot: join(APP, 'services', 'gateway'),
    nodeRuntime: { command: join(APP, 'dagents.exe'), env: { ELECTRON_RUN_AS_NODE: '1' } },
  }

  function makeWorld() {
    const world = new FakeWorld()
    world.files.set(PG_BIN, 'bin')
    world.files.set(join(DATA_DIR, 'PG_VERSION'), '16')
    world.runOnceQueue = [{ code: 0, stdout: 'db: schema already up to date' }]
    return world
  }

  it('三服务全走 execPath + ELECTRON_RUN_AS_NODE + 内嵌产物入口（端口 env 计划注入）', async () => {
    const world = makeWorld()
    const orch = new Orchestrator(defaultConfig(join(ROOT, 'repo')), world.deps, {
      pgPaths,
      runMode: 'packaged',
      packaged: { servicesDir: join(APP, 'services'), execPath: join(APP, 'dagents.exe') },
    })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(500)

    const snap = orch.snapshot()
    expect(snap.config.runMode).toBe('packaged')
    expect(snap.phase).toBe('console') // packaged 全链：pg→migrate→gateway→console 健康

    // gateway：deploy 产物入口 + RUN_AS_NODE + GATEWAY_PORT + 内嵌 DSN
    const gw = world.spawnedSpecs.find((s) => s.id === 'gateway')
    expect(gw?.command).toBe(join(APP, 'dagents.exe'))
    expect(gw?.args.map(normPath)).toEqual([normPath(join(APP, 'services', 'gateway', 'dist', 'index.js'))])
    expect(normPath(gw?.cwd ?? '')).toBe(normPath(join(APP, 'services', 'gateway')))
    expect(gw?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(gw?.env?.GATEWAY_PORT).toBe('8080')
    expect(gw?.env?.POSTGRES_URL).toBe('postgresql://dagents@127.0.0.1:55432/dagents')

    // console：standalone server.js（app 目录直下）+ PORT/HOSTNAME/GATEWAY_URL/NODE_ENV=production
    const cs = world.spawnedSpecs.find((s) => s.id === 'console')
    expect(cs?.command).toBe(join(APP, 'dagents.exe'))
    expect(cs?.args.map(normPath)).toEqual([
      normPath(join(APP, 'services', 'console', 'apps', 'console', 'server.js')),
    ])
    expect(cs?.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: '3000',
      HOSTNAME: '127.0.0.1',
      GATEWAY_URL: 'http://localhost:8080',
    })

    // 迁移走 staged migrate.mjs 且载体是 execPath（ELECTRON_RUN_AS_NODE）
    const migrate = world.runOnceSpecs[0]
    expect(migrate.command).toBe(join(APP, 'dagents.exe'))
    expect(normPath(migrate.args[0] ?? '')).toBe(
      normPath(join(APP, 'services', 'gateway', 'node_modules', '@dagents', 'db', 'scripts', 'migrate.mjs'))
    )
    expect(migrate.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('config.services 的 command 在 packaged 下被忽略（内嵌栈是唯一形态）', async () => {
    const world = makeWorld()
    const config = defaultConfig(join(ROOT, 'repo'))
    config.services.gateway.command = 'weird-custom-command'
    const orch = new Orchestrator(config, world.deps, {
      pgPaths,
      runMode: 'packaged',
      packaged: { servicesDir: join(APP, 'services'), execPath: join(APP, 'dagents.exe') },
    })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: DAGENTS_HTML },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(500)
    const gw = world.spawnedSpecs.find((s) => s.id === 'gateway')
    expect(gw?.command).toBe(join(APP, 'dagents.exe'))
  })

  it('让位形态：3000 陌生占用 → console 让位 3001，PORT/GATEWAY_URL/consoleUrl 全单源', async () => {
    const world = makeWorld()
    world.openPorts.add(3000) // 陌生 dev server 占默认端口
    world.identityQueue = [{ status: 200, body: '<title>Vite + TS</title>' }] // console 身份=陌生
    const orch = new Orchestrator(defaultConfig(join(ROOT, 'repo')), world.deps, {
      pgPaths,
      runMode: 'packaged',
      packaged: { servicesDir: join(APP, 'services'), execPath: join(APP, 'dagents.exe') },
    })
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' }, // gateway（8080 未占）
      { status: 200, body: DAGENTS_HTML }, // 让位 3001 上的 console 健康
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)

    const snap = orch.snapshot()
    expect(snap.phase).toBe('console') // 让位后照样双健康接管
    expect(snap.config.consolePort).toBe(3001)
    expect(snap.config.consoleUrl).toBe('http://localhost:3001') // 窗口接管 URL 单源派生
    expect(snap.config.consoleYielded).toBe(true) // M9：快照 yielded 标记（渲染层 chip 数据源）
    expect(snap.config.gatewayYielded).toBe(false)
    // M9：服务卡 message 铺设计划让位文案（decoratePlacement，pg yielded 语义平移）
    expect(snap.services.console.state).toBe('running')
    expect(snap.services.console.message).toContain('3001')
    expect(snap.services.console.message).toContain('已让位')
    const cs = world.spawnedSpecs.find((s) => s.id === 'console')
    expect(cs?.env?.PORT).toBe('3001')
    expect(cs?.env?.GATEWAY_URL).toBe('http://localhost:8080') // BFF 指实际 gateway
    expect(world.logs.console.some((l) => l.includes('让位'))).toBe(true)
  })

  function normPath(p: string): string {
    return p.replace(/\\/g, '/')
  }
})
