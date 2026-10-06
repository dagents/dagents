import { join } from 'node:path'
import { PgServiceController, resolvePgPaths, type PgDeps, type PgRuntimePaths } from './pg-service'
import { packagedRunSpecs, type RunMode } from './run-mode'
import {
  createMachine,
  transition,
  type MachineState,
  type ServiceEvent,
} from './state-machine'
import type {
  DesktopConfig,
  DesktopSnapshot,
  ManagedServiceId,
  ServiceId,
  ServiceRunSpec,
  ServiceState,
  ServiceStatus,
} from './types'

// supervisor：把纯状态机的 effects 落到真实世界（spawn/HTTP 探测/定时器/日志）。
// 一切副作用经 SupervisorDeps 注入——单测用假时钟/假 HTTP/假 spawn 全速驱动
// （supervisor.test.ts），真接线见 ../spawn-runtime.ts。
// pg 服务（M5，docs §10.2）：同一状态机/重启预算/树终止，差异面全部经
// SupervisorOptions 注入——TCP 探活替代 HTTP、运行时构造的 spawn 规格、
// 不做端口附加（让位逻辑在 PgServiceController）。

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

/** 服务级差异注入（默认 = gateway/console 现行为；pg 的变体见 pg-service.ts）。 */
export interface SupervisorOptions {
  /**
   * 健康探测变体。默认 HTTP（healthUrl + healthResultToEvent 判活）；
   * pg 传 TCP 端口探活（pg_isready 不随二进制包分发，docs §10.2 判活协议）。
   */
  probe?: (port: number) => Promise<HttpResult>
  /** spawn 规格（默认 config.services[id] + repoRoot cwd + extraEnv）。 */
  runSpec?: () => ServiceRunSpec
  /** 健康探测端口（默认 config.services[id].port——pg 让位后端口运行时才定）。 */
  port?: number
  /** 端口被占时是否附加而非 spawn（默认 true；pg false——冲突让位，不附加）。 */
  attachable?: boolean
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
  // console：HTTP 2xx 即健康（Next.js 首页）；pg：TCP 探针产 200（端口 accept 即活）
  if (res.status >= 200 && res.status < 300) return { type: 'HEALTH_OK', db: 'unknown' }
  return { type: 'HEALTH_FAIL', error: `HTTP ${res.status}` }
}

export function healthUrl(id: ManagedServiceId, port: number): string {
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
  private exitSuppressed = false
  private probe: (port: number) => Promise<HttpResult>
  private runSpec: () => ServiceRunSpec
  private portOf: () => number
  private attachable: boolean

  constructor(
    id: ServiceId,
    private deps: SupervisorDeps,
    private config: DesktopConfig,
    private onChange: () => void,
    options: SupervisorOptions = {}
  ) {
    this.id = id
    this.machine = createMachine(id)
    this.attachable = options.attachable ?? true
    this.probe =
      options.probe ??
      ((port) => this.deps.httpGet(healthUrl(id as ManagedServiceId, port), HTTP_TIMEOUT_MS))
    this.runSpec =
      options.runSpec ??
      (() => {
        const spec = this.config.services[id as ManagedServiceId]
        return {
          command: spec.command,
          args: spec.args,
          cwd: this.config.repoRoot,
          env: this.config.extraEnv,
        }
      })
    this.portOf =
      options.port !== undefined
        ? () => options.port as number
        : () => this.config.services[id as ManagedServiceId].port
  }

  get status(): ServiceStatus {
    return this.machine.status
  }

  get state(): ServiceState {
    return this.machine.status.state
  }

  /**
   * 抑制后续 EXIT 事件（只记日志不进状态机）——优雅停止前置：pg_ctl stop 会让
   * postgres.exe 退出，若不抑制会按「意外退出」进重启预算（docs §10.2 停止顺序）。
   */
  suppressExit(): void {
    this.exitSuppressed = true
  }

  /** 启动：端口已听 → 附加（不 spawn）；否则 START → spawn。幂等（机器层兜底）。 */
  async start(): Promise<void> {
    this.stopped = false
    this.exitSuppressed = false
    if (this.machine.status.state !== 'idle' && this.machine.status.state !== 'stopped') return
    if (this.attachable) {
      const portOpen = await this.deps.isPortOpen(this.portOf())
      if (portOpen) {
        this.deps.log(this.id, `端口 ${this.portOf()} 已被监听 → 附加模式（不 spawn）`)
        this.dispatch({ type: 'SPAWNED', attach: true })
        return
      }
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
    const spec = this.runSpec()
    try {
      const handle = this.deps.spawnService(this.id, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
      })
      this.deps.log(
        this.id,
        `spawn pid=${handle.pid ?? '?'}：${spec.command} ${spec.args.join(' ')}（cwd=${spec.cwd}）`
      )
      handle.onExit((code) => {
        if (this.exitSuppressed) {
          this.deps.log(this.id, `进程退出 code=${code}（优雅停止流程中，不触发重启）`)
          return
        }
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
      const res = await this.probe(this.portOf())
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
 * （pg 不参与判定——其健康已内含于 gateway db:'up' 端到端语义，docs §10.5。）
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
  private supervisors: Record<ManagedServiceId, ServiceSupervisor>
  private listeners = new Set<() => void>()
  private gatewayEnv: Record<string, string>
  private runMode: RunMode
  private pg: PgServiceController

  constructor(
    private config: DesktopConfig,
    private deps: PgDeps,
    opts: {
      pgPaths?: PgRuntimePaths
      pg?: PgServiceController
      /** 实际运行形态（index.ts 经 resolveRunMode 探测；缺省 dev）。 */
      runMode?: RunMode
      /** packaged 形态定位（runMode='packaged' 时必带）。 */
      packaged?: { servicesDir: string; execPath: string }
    } = {}
  ) {
    this.runMode = opts.runMode ?? 'dev'
    const make = (id: ManagedServiceId) =>
      new ServiceSupervisor(id, deps, config, () => this.emit())
    // gateway 的 env 在 pg 就绪后追加 POSTGRES_URL（extraEnv 通道，docs §10.2）——
    // 引用同一对象，doSpawn 时才读取，时序安全。
    this.gatewayEnv = { ...config.extraEnv }
    // packaged：两服务改走内嵌产物入口（ELECTRON_RUN_AS_NODE，docs §11.1/§11.4）；
    // config.services 的 command/args 仅 dev 形态消费。
    const packagedSpecs =
      this.runMode === 'packaged' && opts.packaged
        ? packagedRunSpecs({
            servicesDir: opts.packaged.servicesDir,
            execPath: opts.packaged.execPath,
            extraEnv: config.extraEnv,
          })
        : null
    this.supervisors = {
      gateway: new ServiceSupervisor('gateway', deps, config, () => this.emit(), {
        runSpec: () =>
          packagedSpecs
            ? { ...packagedSpecs.gateway, env: { ...packagedSpecs.gateway.env, ...this.gatewayEnv } }
            : {
                command: config.services.gateway.command,
                args: config.services.gateway.args,
                cwd: config.repoRoot,
                env: this.gatewayEnv,
              },
      }),
      console: packagedSpecs
        ? new ServiceSupervisor('console', deps, config, () => this.emit(), {
            runSpec: () => ({ ...packagedSpecs.console, env: { ...packagedSpecs.console.env } }),
          })
        : make('console'),
    }
    // pgPaths 缺省时按 monorepo 布局从 repoRoot 推（dev：desktop 包在 apps/desktop 下；
    // packaged 形态由 index.ts 显式传 resources 下的路径）
    this.pg =
      opts.pg ??
      new PgServiceController(config, deps, {
        paths:
          opts.pgPaths ??
          resolvePgPaths(config.postgres, {
            userDataDir: join(config.repoRoot, 'apps', 'desktop', '.pgdata-dev'),
            desktopDir: join(config.repoRoot, 'apps', 'desktop'),
            repoRoot: config.repoRoot,
          }),
        createSupervisor: (options) =>
          new ServiceSupervisor('pg', deps, config, () => this.emit(), options),
        emit: () => this.emit(),
      })
  }

  start(): void {
    void this.startAsync()
  }

  /**
   * 启动编排（docs §10.2）：附加模式（gateway 端口被外部占用）→ 不 spawn 任何东西；
   * 内嵌 PG 启用 → pg（initdb 幂等 → postgres 前台直跑 → 建库 → 迁移）就绪后
   * gateway（注入内嵌 DSN）+ console 并行；pg 失败 → gateway 不启动（诚实展示）。
   */
  private async startAsync(): Promise<void> {
    const gatewayAttached = await this.deps.isPortOpen(this.config.services.gateway.port)
    if (gatewayAttached) {
      this.pg.markSkipped('附加模式：gateway 端口已被外部实例监听——不启动内嵌 Postgres（外部栈自带数据库）')
    } else if (this.pg.enabled) {
      const ready = await this.pg.start()
      if (!ready.ok) {
        this.deps.log('pg', `内嵌 Postgres 未就绪，gateway 不启动（对齐 docker-entrypoint 语义）`)
        this.emit()
        return
      }
      this.gatewayEnv.POSTGRES_URL = ready.dsn
      this.deps.log('pg', `gateway 将注入 POSTGRES_URL=${ready.dsn}`)
    }
    void this.supervisors.gateway.start()
    void this.supervisors.console.start()
  }

  /**
   * 全停，反依赖序 console → gateway → pg（docs §10.2）：树终止 + 定时器清理 +
   * 端口释放校验（未释放只告警不扩杀——R2）；pg 走 pg_ctl stop -m fast 优先。
   */
  async stopAll(): Promise<Record<ServiceId, boolean>> {
    this.supervisors.console.stop()
    this.supervisors.gateway.stop()
    const report: Record<ServiceId, boolean> = { gateway: true, console: true, pg: true }
    for (const id of ['gateway', 'console'] as ManagedServiceId[]) {
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
    report.pg = await this.pg.stop()
    this.supervisors.gateway.dispose()
    this.supervisors.console.dispose()
    this.emit()
    return report
  }

  /** 手动重启（菜单「重启服务」/重试按钮）：全停 → 重新编排（预算清零）。 */
  async restartAll(): Promise<void> {
    await this.stopAll()
    await this.startAsync()
  }

  retry(id: ServiceId): void {
    if (id === 'pg') return // pg 的重试经 restartAll（bootstrap 管线含其中）
    this.supervisors[id].retry()
  }

  snapshot(): DesktopSnapshot {
    return {
      phase: computePhase(this.supervisors.gateway.status, this.supervisors.console.status),
      services: {
        gateway: this.supervisors.gateway.status,
        console: this.supervisors.console.status,
        pg: this.pg.status(),
      },
      logTail: {
        gateway: this.supervisors.gateway.logTail(30),
        console: this.supervisors.console.logTail(30),
        pg: this.pg.logTail(30),
      },
      config: {
        repoRoot: this.config.repoRoot,
        consoleUrl: this.config.consoleUrl,
        gatewayPort: this.config.services.gateway.port,
        consolePort: this.config.services.console.port,
        runMode: this.runMode,
        pgPort: this.pg.actualPort,
        pgEmbedded: this.pg.enabled,
        pgDataDir: this.pg.dataDir,
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
