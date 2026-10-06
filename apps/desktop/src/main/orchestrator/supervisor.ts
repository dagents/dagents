import {
  createMachine,
  transition,
  type MachineState,
  type ServiceEvent,
} from './state-machine'
import type {
  DesktopConfig,
  DesktopSnapshot,
  ServiceId,
  ServiceState,
  ServiceStatus,
} from './types'

// supervisor：把纯状态机的 effects 落到真实世界（spawn/HTTP 探测/定时器/日志）。
// 一切副作用经 SupervisorDeps 注入——单测用假时钟/假 HTTP/假 spawn 全速驱动
// （supervisor.test.ts），真接线见 ../spawn-runtime.ts。

export interface SpawnHandle {
  pid?: number
  onExit(cb: (code: number | null) => void): void
  onStdout(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
}

export type HttpResult = { status: number; body: string } | { error: string }

export interface SupervisorDeps {
  spawnService(
    id: ServiceId,
    spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }
  ): SpawnHandle
  httpGet(url: string, timeoutMs: number): Promise<HttpResult>
  isPortOpen(port: number): Promise<boolean>
  killTree(pid: number): void | Promise<void>
  now(): number
  setTimer(cb: () => void, ms: number): object
  clearTimer(handle: object): void
  log(id: ServiceId, line: string): void
  getLogTail(id: ServiceId, n: number): string[]
}

const HTTP_TIMEOUT_MS = 4_000

/** 健康判定结果 → 状态机事件映射（判活协议见 docs §3.1）。 */
export function healthResultToEvent(id: ServiceId, res: HttpResult): ServiceEvent {
  if ('error' in res) return { type: 'HEALTH_FAIL', error: res.error }
  if (id === 'gateway') {
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body) as { ok?: unknown; db?: unknown }
        if (body.ok === true) return { type: 'HEALTH_OK', db: 'up' }
        if (body.db === 'down') return { type: 'HEALTH_OK', db: 'down' } // 503 db:down——进程活着
      } catch {
        // 非法 JSON 按失败处理
      }
      return { type: 'HEALTH_FAIL', error: `/health 200 但 body 异常：${res.body.slice(0, 120)}` }
    }
    if (res.status === 503) {
      try {
        const body = JSON.parse(res.body) as { db?: unknown }
        if (body.db === 'down') return { type: 'HEALTH_OK', db: 'down' }
      } catch {
        // fallthrough
      }
      return { type: 'HEALTH_FAIL', error: `/health 503：${res.body.slice(0, 120)}` }
    }
    return { type: 'HEALTH_FAIL', error: `/health ${res.status}` }
  }
  // console：HTTP 200 即健康（Next.js 首页）
  if (res.status >= 200 && res.status < 300) return { type: 'HEALTH_OK', db: 'unknown' }
  return { type: 'HEALTH_FAIL', error: `HTTP ${res.status}` }
}

export function healthUrl(id: ServiceId, port: number): string {
  return id === 'gateway' ? `http://localhost:${port}/health` : `http://localhost:${port}/`
}

/** 单服务监督器：机器 + 轮询/退避定时器 + 期限跟踪。 */
export class ServiceSupervisor {
  readonly id: ServiceId
  private machine: MachineState
  private healthTimer: object | null = null
  private healthIntervalMs = 500
  private restartTimer: object | null = null
  private firstFailAt: number | null = null
  private pollInFlight = false
  private stopped = false

  constructor(
    id: ServiceId,
    private deps: SupervisorDeps,
    private config: DesktopConfig,
    private onChange: () => void
  ) {
    this.id = id
    this.machine = createMachine(id)
  }

  get status(): ServiceStatus {
    return this.machine.status
  }

  get state(): ServiceState {
    return this.machine.status.state
  }

  /** 启动：端口已听 → 附加（不 spawn）；否则 START → spawn。幂等（机器层兜底）。 */
  async start(): Promise<void> {
    this.stopped = false
    if (this.machine.status.state !== 'idle' && this.machine.status.state !== 'stopped') return
    const portOpen = await this.deps.isPortOpen(this.config.services[this.id].port)
    if (portOpen) {
      this.deps.log(this.id, `端口 ${this.config.services[this.id].port} 已被监听 → 附加模式（不 spawn）`)
      this.dispatch({ type: 'SPAWNED', attach: true })
      return
    }
    this.dispatch({ type: 'START' })
  }

  /** 手动重试（failed → 预算清零重启）。 */
  retry(): void {
    this.dispatch({ type: 'RETRY' })
  }

  /** 停止：树终止 + 清定时器；端口释放校验由 Orchestrator 统一做。 */
  stop(): void {
    this.stopped = true
    this.dispatch({ type: 'STOP' })
  }

  dispatch(event: ServiceEvent): void {
    const result = transition(this.machine, event, this.config.restartPolicy, this.deps.now())
    if (result.machine === this.machine && result.effects.length === 0) return
    this.machine = result.machine
    for (const effect of result.effects) this.applyEffect(effect)
    this.onChange()
  }

  private applyEffect(
    effect: { kind: string; delayMs?: number; ms?: number; pid?: number }
  ): void {
    switch (effect.kind) {
      case 'spawn':
        this.doSpawn()
        break
      case 'kill-tree': {
        const pid = effect.pid
        if (typeof pid === 'number') {
          this.deps.log(this.id, `终止进程树 pid=${pid}（taskkill /T /F）`)
          void Promise.resolve(this.deps.killTree(pid))
        }
        break
      }
      case 'schedule-restart': {
        this.clearRestartTimer()
        const delay = effect.delayMs ?? 1000
        this.restartTimer = this.deps.setTimer(() => {
          this.restartTimer = null
          this.dispatch({ type: 'RESTART_DUE' })
        }, delay)
        break
      }
      case 'clear-restart-timer':
        this.clearRestartTimer()
        break
      case 'set-health-interval':
        // 只更新节拍；轮询链自续（避免每次 ok 都开新链导致轮询链倍增）。
        // 链未启动（SPAWNED 后首次）才点火。
        this.healthIntervalMs = effect.ms ?? 500
        this.firstFailAt = null
        if (this.healthTimer === null) this.scheduleNextPoll(0)
        break
      case 'stop-health-polling':
        this.clearHealthTimer()
        break
      default:
        break
    }
  }

  private doSpawn(): void {
    const spec = this.config.services[this.id]
    try {
      const handle = this.deps.spawnService(this.id, {
        command: spec.command,
        args: spec.args,
        cwd: this.config.repoRoot,
        env: this.config.extraEnv,
      })
      this.deps.log(
        this.id,
        `spawn pid=${handle.pid ?? '?'}：${spec.command} ${spec.args.join(' ')}（cwd=${this.config.repoRoot}）`
      )
      handle.onExit((code) => {
        this.deps.log(this.id, `进程退出 code=${code}`)
        this.dispatch({ type: 'EXIT', code })
      })
      const wire = (stream: 'stdout' | 'stderr') => (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line !== '') this.deps.log(this.id, `[${stream}] ${line}`)
        }
      }
      handle.onStdout(wire('stdout'))
      handle.onStderr(wire('stderr'))
      this.dispatch({ type: 'SPAWNED', pid: handle.pid })
    } catch (e) {
      this.dispatch({ type: 'SPAWN_FAILED', error: e instanceof Error ? e.message : String(e) })
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    this.clearHealthTimer()
    if (this.stopped) return
    this.healthTimer = this.deps.setTimer(() => {
      void this.pollOnce().then(() => {
        if (
          this.machine.status.state === 'waiting_health' ||
          this.machine.status.state === 'running'
        ) {
          this.scheduleNextPoll(this.healthIntervalMs)
        }
      })
    }, delayMs)
  }

  private async pollOnce(): Promise<void> {
    const state = this.machine.status.state
    if (state !== 'waiting_health' && state !== 'running') return
    if (this.pollInFlight) return
    this.pollInFlight = true
    try {
      const url = healthUrl(this.id, this.config.services[this.id].port)
      const res = await this.deps.httpGet(url, HTTP_TIMEOUT_MS)
      const event = healthResultToEvent(this.id, res)
      if (event.type === 'HEALTH_OK') {
        this.firstFailAt = null
        this.dispatch(event)
        return
      }
      // HEALTH_FAIL：单次不动状态；持续超期限 → HEALTH_TIMEOUT
      const now = this.deps.now()
      if (this.firstFailAt === null) this.firstFailAt = now
      if (now - this.firstFailAt >= this.config.restartPolicy.healthTimeoutMs) {
        this.deps.log(this.id, `健康持续失败超过 ${Math.round(this.config.restartPolicy.healthTimeoutMs / 1000)}s，按意外退出处理`)
        this.firstFailAt = null
        this.dispatch({ type: 'HEALTH_TIMEOUT' })
        return
      }
      // 只记日志不动状态（启动期失败很常见：端口还没起来）
      if ('error' in res) this.deps.log(this.id, `健康探测失败：${res.error}`)
    } finally {
      this.pollInFlight = false
    }
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== null) {
      this.deps.clearTimer(this.healthTimer)
      this.healthTimer = null
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      this.deps.clearTimer(this.restartTimer)
      this.restartTimer = null
    }
  }

  dispose(): void {
    this.clearHealthTimer()
    this.clearRestartTimer()
  }

  logTail(n: number): string[] {
    return this.deps.getLogTail(this.id, n)
  }
}

/**
 * 就绪接管判定（docs §3.1 单窗口两阶段）：gateway 健康（running 且 db up——
 * 503 db:down 是降级不算健康，不接管）+ console running → 'console'（阶段 B），
 * 其余一律 'boot'（阶段 A 启动态页）。附加模式同样适用：双健康即接管直连。
 */
export function computePhase(
  gateway: ServiceStatus,
  consoleSvc: ServiceStatus
): DesktopSnapshot['phase'] {
  const gatewayHealthy = gateway.state === 'running' && gateway.db === 'up'
  const consoleHealthy = consoleSvc.state === 'running'
  return gatewayHealthy && consoleHealthy ? 'console' : 'boot'
}

/** 双服务编排门面（渲染层快照单源）。 */
export class Orchestrator {
  private supervisors: Record<ServiceId, ServiceSupervisor>
  private listeners = new Set<() => void>()

  constructor(
    private config: DesktopConfig,
    private deps: SupervisorDeps
  ) {
    const make = (id: ServiceId) =>
      new ServiceSupervisor(id, deps, config, () => this.emit())
    this.supervisors = { gateway: make('gateway'), console: make('console') }
  }

  start(): void {
    void this.supervisors.gateway.start()
    void this.supervisors.console.start()
  }

  /** 全停（树终止 + 定时器清理 + 端口释放校验；未释放只告警不扩杀——R2）。 */
  async stopAll(): Promise<{ gateway: boolean; console: boolean }> {
    for (const sup of Object.values(this.supervisors)) sup.stop()
    for (const sup of Object.values(this.supervisors)) sup.dispose()
    const report = { gateway: true, console: true } as Record<ServiceId, boolean>
    for (const id of ['gateway', 'console'] as ServiceId[]) {
      const port = this.config.services[id].port
      const released = await this.deps.isPortOpen(port).then((open) => !open)
      if (!released) {
        // 给树终止一点落地时间再复查一次
        await new Promise<void>((r) => this.deps.setTimer(() => r(), 1500))
        report[id] = !(await this.deps.isPortOpen(port))
      } else {
        report[id] = true
      }
      if (!report[id]) {
        this.deps.log(id, `停止后端口 ${port} 仍被占用——进程树终止可能漏杀，请人工检查（MVP 只告警不扩杀）`)
      }
    }
    this.emit()
    return { gateway: report.gateway, console: report.console }
  }

  /** 手动重启（菜单「重启服务」/重试按钮）：全停 → 重新 start（预算清零）。 */
  async restartAll(): Promise<void> {
    await this.stopAll()
    this.start()
  }

  retry(id: ServiceId): void {
    this.supervisors[id].retry()
  }

  snapshot(): DesktopSnapshot {
    return {
      phase: computePhase(this.supervisors.gateway.status, this.supervisors.console.status),
      services: {
        gateway: this.supervisors.gateway.status,
        console: this.supervisors.console.status,
      },
      logTail: {
        gateway: this.supervisors.gateway.logTail(30),
        console: this.supervisors.console.logTail(30),
      },
      config: {
        repoRoot: this.config.repoRoot,
        consoleUrl: this.config.consoleUrl,
        gatewayPort: this.config.services.gateway.port,
        consolePort: this.config.services.console.port,
      },
      at: this.deps.now(),
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}
