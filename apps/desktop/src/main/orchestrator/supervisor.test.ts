import { describe, expect, it } from 'vitest'
import { defaultConfig } from './config'
import {
  computePhase,
  healthResultToEvent,
  healthUrl,
  Orchestrator,
  ServiceSupervisor,
  type HttpResult,
  type SpawnHandle,
  type SupervisorDeps,
} from './supervisor'
import type { ServiceId, ServiceStatus } from './types'

// supervisor 单测：假时钟/假 HTTP/假 spawn 全速驱动（docs §6 编排器核心场景），
// 不碰真进程真网络——真子进程树终止与真端口探测在 tree-kill.test.ts / ports.test.ts。

/** 假世界：手动时钟 + 定时器队列 + 可编排的 HTTP 应答队列 + spawn 记录。 */
class FakeWorld {
  now = 1_000_000
  timers = new Map<number, { cb: () => void; at: number }>()
  private timerSeq = 1
  logs: Record<ServiceId, string[]> = { gateway: [], console: [] }
  httpQueue: HttpResult[] = []
  httpRequests: string[] = []
  portsOpen = { gateway: false, console: false }
  spawnedSpecs: { id: ServiceId; command: string; args: string[]; cwd: string }[] = []
  killedPids: number[] = []
  spawnHandles: FakeSpawnHandle[] = []
  private nextPid = 1000

  deps: SupervisorDeps = {
    spawnService: (id, spec) => {
      this.spawnedSpecs.push({ id, command: spec.command, args: spec.args, cwd: spec.cwd })
      const handle = new FakeSpawnHandle(this.nextPid++)
      this.spawnHandles.push(handle)
      return handle
    },
    httpGet: async (url, timeoutMs) => {
      expect(timeoutMs).toBeGreaterThan(0)
      this.httpRequests.push(url)
      const next = this.httpQueue.shift()
      return next ?? { error: 'ECONNREFUSED (queue empty)' }
    },
    isPortOpen: async (port) =>
      port === 8080 ? this.portsOpen.gateway : this.portsOpen.console,
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
  }

  /** 推进假时钟，触发所有到期定时器（含级联：退避到期 → spawn → 轮询 0ms）。 */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (let guard = 0; guard < 200; guard++) {
      // 每轮先冲刷微任务——被测代码常在 await 链之后才注册下一个定时器
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) break
      for (const [id, t] of due) {
        this.timers.delete(id)
        this.now = Math.max(this.now, t.at)
        t.cb()
        // 让 pollOnce 的微任务/await 落地
        await Promise.resolve()
        await Promise.resolve()
      }
    }
    this.now = target
    await Promise.resolve()
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
    world.portsOpen.gateway = true
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
  it('snapshot 含双服务状态/日志尾/配置投影；onChange 触发订阅者', async () => {
    const world = new FakeWorld()
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps)
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
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps)
    world.httpQueue = [
      { status: 200, body: '{"ok":true,"db":"up"}' },
      { status: 200, body: 'ok' },
    ]
    orch.start()
    await world.advance(10)
    await world.advance(600)

    // 模拟「外部别的进程占着 3000」：kill 后端口仍开
    world.portsOpen.console = true
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
    const orch = new Orchestrator(defaultConfig('C:/repo'), world.deps)
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
