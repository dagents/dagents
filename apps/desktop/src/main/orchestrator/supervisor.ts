import { join } from 'node:path'
import { classifyConsoleIdentity, probeUrl } from './identity'
import { planPortAllocation, type PortPlan } from './port-plan'
import { PgServiceController, resolvePgPaths, type PgDeps, type PgRuntimePaths } from './pg-service'
import { packagedRunSpecs, type RunMode } from './run-mode'
import {
  createMachine,
  transition,
  type MachineState,
  type ServiceEvent,
} from './state-machine'
import type {
  ContentIntent,
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
// SupervisorOptions 注入——TCP 探活替代 HTTP、运行时构造的 spawn 规格。
// 端口计划（M8，docs §18）：附加判定从「端口开」升级为「端口开且身份判别为
// dagents」（planPortAllocation 预先判定，Orchestrator.startAsync 单点求 plan）；
// 实际端口单一事实源是 PortPlan——健康探测/spawn env/快照全读它。

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
   * 健康探测变体。默认 HTTP（probeUrl + healthResultToEvent 判活）；
   * pg 传 TCP 端口探活（pg_isready 不随二进制包分发，docs §10.2 判活协议）。
   */
  probe?: (port: number) => Promise<HttpResult>
  /** spawn 规格（默认 config.services[id] + repoRoot cwd + extraEnv）。 */
  runSpec?: () => ServiceRunSpec
  /**
   * 健康探测端口（默认 config.services[id].port）。get 形式——gateway/console
   * 的实际端口在每次 startAsync 求计划时才定（让位/附加，docs §18.2）。
   */
  port?: () => number
}

const HTTP_TIMEOUT_MS = 4_000

/** 健康判定结果 → 状态机事件映射（判活协议见 docs §3.1；console 判活含身份特征 §18.3）。 */
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
  if (id === 'console') {
    // 身份特征判活（docs §18.3 病灶②收口）：2xx 且 title 含 Dagents 才算健康——
    // 陌生 web 服务占端口的形态（任意 2xx 即健康）不再被误判为「console 已就绪」。
    if (res.status >= 200 && res.status < 300) {
      if (classifyConsoleIdentity(res) === 'dagents') {
        return { type: 'HEALTH_OK', db: 'unknown' }
      }
      return {
        type: 'HEALTH_FAIL',
        error: `HTTP ${res.status} 但页面非 dagents console（title 不含 "Dagents"）：${res.body.slice(0, 120)}`,
      }
    }
    return { type: 'HEALTH_FAIL', error: `HTTP ${res.status}` }
  }
  // pg：TCP 探针产 200（端口 accept 即活）
  if (res.status >= 200 && res.status < 300) return { type: 'HEALTH_OK', db: 'unknown' }
  return { type: 'HEALTH_FAIL', error: `HTTP ${res.status}` }
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

  constructor(
    id: ServiceId,
    private deps: SupervisorDeps,
    private config: DesktopConfig,
    private onChange: () => void,
    options: SupervisorOptions = {}
  ) {
    this.id = id
    this.machine = createMachine(id)
    this.probe =
      options.probe ??
      ((port) => this.deps.httpGet(probeUrl(id as ManagedServiceId, port), HTTP_TIMEOUT_MS))
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
      options.port ??
      (() => this.config.services[id as ManagedServiceId].port)
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

  /**
   * 启动（docs §18.2/§18.3，M8）：附加/自起由端口计划预先判定（Orchestrator.startAsync
   * 单点求 plan——身份判别「端口开且是 dagents」在那层完成），本方法只按指令落地：
   *   attach=true  → SPAWNED{attach}（不 spawn、不代杀——附加态无 pid 天然不杀）
   *   attach=false → START → spawn（runSpec/env 已带计划端口）
   * 旧的「isPortOpen 即附加」盲判定已退役（病灶②：陌生 web 服务曾被误附加）。
   * 幂等（机器层兜底）。
   */
  async start(directive: { attach?: boolean } = {}): Promise<void> {
    this.stopped = false
    this.exitSuppressed = false
    if (this.machine.status.state !== 'idle' && this.machine.status.state !== 'stopped') return
    if (directive.attach === true) {
      this.deps.log(
        this.id,
        `端口 ${this.portOf()} 检测到 dagents 实例 → 附加模式（不 spawn、不代杀）`
      )
      this.dispatch({ type: 'SPAWNED', attach: true })
      return
    }
    this.dispatch({ type: 'START' })
  }

  /** 端口计划失败（dev 固定端口被陌生程序占/候选耗尽/钉死冲突）→ 诚实 failed。 */
  failPlacement(reason: string): void {
    this.dispatch({ type: 'PLACEMENT_FAILED', error: reason })
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
  private packaged: { servicesDir: string; execPath: string } | null
  private contentIntent?: () => ContentIntent
  private about: { appVersion: string; logsDir: string }
  private parentEnv: Record<string, string>
  private pg: PgServiceController
  /** 实际端口单一事实源（docs §18.2）：startAsync 求出、restartAll 重求。 */
  private portPlan: PortPlan | null = null

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
      /** 窗口内容意愿注入（takeover 控制器闭包；缺省恒 auto——契约由 tsc 钉住）。 */
      contentIntent?: () => ContentIntent
      /** 关于面板信息（app.getVersion()/日志目录——纯展示投影，缺省空串）。 */
      about?: { appVersion: string; logsDir: string }
      /** 服务子进程的环境基底。生产不变量：index.ts 必须显式传 process.env——
       * PATH 等父环境键必须被继承，否则 gateway 内 spawn CLI agent（claude/hermes）ENOENT；
       * 缺省空对象让测试确定性（CI 全局 env 不渗入断言）。 */
      parentEnv?: Record<string, string>
    } = {}
  ) {
    this.runMode = opts.runMode ?? 'dev'
    this.packaged = opts.packaged ?? null
    this.contentIntent = opts.contentIntent
    this.about = opts.about ?? { appVersion: '', logsDir: '' }
    this.parentEnv = opts.parentEnv ?? {}
    // gateway 的 env 在 pg 就绪后追加 POSTGRES_URL（extraEnv 通道，docs §10.2）——
    // 引用同一对象，doSpawn 时才读取，时序安全。
    this.gatewayEnv = { ...config.extraEnv }
    // 端口/规格全动态（docs §18.2）：让位/附加端口在每次 startAsync 求计划时才定，
    // supervisor 的健康探测端口与 spawn env 经 getter 每次现读 plan。
    this.supervisors = {
      gateway: new ServiceSupervisor('gateway', deps, config, () => this.emit(), {
        port: () => this.planPort('gateway'),
        runSpec: () => this.buildRunSpec('gateway'),
      }),
      console: new ServiceSupervisor('console', deps, config, () => this.emit(), {
        port: () => this.planPort('console'),
        runSpec: () => this.buildRunSpec('console'),
      }),
    }
    // dev 模式默认不启用内嵌 PG（AC-7④，docs §10.4 第 4 层/§11.4）：dev 用户的外部/
    // docker 库不得被静默切到空内嵌库——编排器跳过内嵌 PG、不注入 DSN，gateway 走
    // .env/extraEnv 的 POSTGRES_URL（未设时 data-source 的 docker 默认 15432）。
    // 豁免：config.json 显式 postgres.embedded=true（loadConfig 标记 embeddedExplicit）。
    if (this.runMode === 'dev' && config.postgres.embedded && !config.postgres.embeddedExplicit) {
      config.postgres.embedded = false
      deps.log(
        'pg',
        'dev 模式默认不启用内嵌 Postgres——gateway 连外部库（POSTGRES_URL 未设时走 docker 默认 15432）；需要内嵌时在 config.json 写 "postgres": {"embedded": true}'
      )
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

  /** 计划端口（无计划时回落 config 默认——构造后/首次 startAsync 前的快照用）。 */
  private planPort(id: ManagedServiceId): number {
    return this.portPlan !== null ? this.portPlan[id].port : this.config.services[id].port
  }

  /**
   * 接管工作台 URL（docs §18.2 下游单源）：config 显式 consoleUrl（逃生门）优先，
   * 否则由计划派生 http://localhost:<console 实际端口>（让位/附加后端口正确）。
   */
  consoleUrl(): string {
    if (this.config.consoleUrl !== '') return this.config.consoleUrl
    if (this.portPlan !== null) return this.portPlan.consoleUrl
    return `http://localhost:${this.config.services.console.port}`
  }

  /** gateway 实际地址（计划派生；让位/附加两形态同一来源）。 */
  gatewayUrl(): string {
    if (this.portPlan !== null) return this.portPlan.gatewayUrl
    return `http://localhost:${this.config.services.gateway.port}`
  }

  /**
   * 服务 spawn 规格（dev/packaged 同源注入，docs §18.4）：端口 env 不写字面量，
   * 全部来自 PortPlan——gateway GATEWAY_PORT、console PORT + BFF GATEWAY_URL；
   * env 顺序 parentEnv（父环境全量——PATH 是 gateway 内 spawn CLI agent 的前提，
   * 2026-10-07 真机缺陷：极简 env 使 spawn claude/hermes ENOENT）→
   * extraEnv（用户逃生门）→ 计划端口（placement 单源）→ gatewayEnv
   * （POSTGRES_URL 由 pg bootstrap 追加，展开在最后自然胜出）。
   */
  private buildRunSpec(id: ManagedServiceId): ServiceRunSpec {
    const gatewayPort = this.planPort('gateway')
    const consolePort = this.planPort('console')
    if (this.runMode === 'packaged' && this.packaged !== null) {
      const specs = packagedRunSpecs({
        servicesDir: this.packaged.servicesDir,
        execPath: this.packaged.execPath,
        parentEnv: this.parentEnv,
        extraEnv: this.config.extraEnv,
        gatewayPort,
        consolePort,
        gatewayUrl: this.gatewayUrl(),
      })
      return id === 'gateway'
        ? { ...specs.gateway, env: { ...specs.gateway.env, ...this.gatewayEnv } }
        : { ...specs.console, env: { ...specs.console.env } }
    }
    const spec = this.config.services[id]
    if (id === 'gateway') {
      return {
        command: spec.command,
        args: spec.args,
        cwd: this.config.repoRoot,
        env: { ...this.parentEnv, ...this.gatewayEnv, GATEWAY_PORT: String(gatewayPort) },
      }
    }
    return {
      command: spec.command,
      args: spec.args,
      cwd: this.config.repoRoot,
      env: {
        ...this.parentEnv,
        ...this.config.extraEnv,
        PORT: String(consolePort),
        GATEWAY_URL: this.gatewayUrl(),
      },
    }
  }

  /**
   * 启动编排（docs §10.2 + §18.2，M8）：先求端口计划（探测+身份判别，一次），
   * 再按计划走 pg bootstrap → gateway/console spawn/attach：
   *   gateway 附加（真 dagents）→ pg skipped（外部栈自带数据库）；
   *   gateway 计划失败（dev 陌生占用/候选耗尽）→ gateway 诚实 failed，下游不起；
   *   pg 未就绪 → gateway 不启动（诚实展示）；console 计划失败独立诚实 failed。
   * restartAll 重跑本方法 = 重新求计划（重探测+重判别，§18.6 自愈入口）。
   */
  private async startAsync(): Promise<void> {
    const plan = await planPortAllocation(
      {
        runMode: this.runMode,
        gateway: {
          preferred: this.config.services.gateway.port,
          pinned: this.config.services.gateway.portExplicit,
        },
        console: {
          preferred: this.config.services.console.port,
          pinned: this.config.services.console.portExplicit,
        },
        pg: { preferred: this.config.postgres.port, enabled: this.pg.enabled },
      },
      {
        isPortOpen: (port) => this.deps.isPortOpen(port),
        httpGet: (url, timeoutMs) => this.deps.httpGet(url, timeoutMs),
        log: (id, line) => this.deps.log(id, line),
      }
    )
    this.portPlan = plan
    for (const id of ['gateway', 'console'] as ManagedServiceId[]) {
      if (plan[id].reason !== null) this.deps.log(id, plan[id].reason as string)
    }

    if (plan.gateway.mode === 'failed') {
      const reason = plan.gateway.reason ?? 'gateway 端口分配失败'
      this.pg.markSkipped(`gateway 端口分配失败——不启动内嵌 Postgres：${reason}`)
      this.supervisors.gateway.failPlacement(reason)
      this.emit()
      return
    }
    if (plan.gateway.mode === 'attach') {
      this.pg.markSkipped(
        '附加模式：gateway 端口已是 dagents 实例——不启动内嵌 Postgres（外部栈自带数据库）'
      )
    } else {
      // enabled=false（显式关 / extraEnv.POSTGRES_URL 自动关 / dev 默认关）时 start()
      // 走 markSkipped 诚实标记并返回 ok + 空 dsn——gateway 照常启动连外部库，不注入。
      const ready = await this.pg.start(plan.pg)
      if (!ready.ok) {
        this.deps.log('pg', `内嵌 Postgres 未就绪，gateway 不启动（对齐 docker-entrypoint 语义）`)
        this.emit()
        return
      }
      if (ready.dsn !== '') {
        this.gatewayEnv.POSTGRES_URL = ready.dsn
        this.deps.log('pg', `gateway 将注入 POSTGRES_URL=${ready.dsn}`)
      }
    }
    void this.supervisors.gateway.start({ attach: plan.gateway.mode === 'attach' })
    if (plan.console.mode === 'failed') {
      this.supervisors.console.failPlacement(plan.console.reason ?? 'console 端口分配失败')
    } else {
      void this.supervisors.console.start({ attach: plan.console.mode === 'attach' })
    }
    this.emit()
  }

  /**
   * 全停，反依赖序 console → gateway → pg（docs §10.2）：树终止 + 定时器清理 +
   * 端口释放校验（未释放只告警不扩杀——R2）；pg 走 pg_ctl stop -m fast 优先。
   * 端口校验读实际计划端口（让位后 ≠ config 默认）；附加态端口属外部实例——
   * 不校验不告警（本 app 从未拥有它）。
   */
  async stopAll(): Promise<Record<ServiceId, boolean>> {
    // attachMode 会被 STOP 转移清零——先快照再停
    const wasAttached: Record<ManagedServiceId, boolean> = {
      gateway: this.supervisors.gateway.status.attachMode,
      console: this.supervisors.console.status.attachMode,
    }
    this.supervisors.console.stop()
    this.supervisors.gateway.stop()
    const report: Record<ServiceId, boolean> = { gateway: true, console: true, pg: true }
    for (const id of ['gateway', 'console'] as ManagedServiceId[]) {
      if (wasAttached[id]) {
        this.deps.log(id, '附加模式端口属外部实例——不由本应用停管，跳过释放校验')
        report[id] = true
        continue
      }
      const port = this.planPort(id)
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
      contentIntent: this.contentIntent?.() ?? 'auto',
      services: {
        gateway: this.decoratePlacement('gateway', this.supervisors.gateway.status),
        console: this.decoratePlacement('console', this.supervisors.console.status),
        pg: this.pg.status(),
      },
      logTail: {
        gateway: this.supervisors.gateway.logTail(30),
        console: this.supervisors.console.logTail(30),
        pg: this.pg.logTail(30),
      },
      config: {
        repoRoot: this.config.repoRoot,
        consoleUrl: this.consoleUrl(),
        gatewayPort: this.planPort('gateway'),
        consolePort: this.planPort('console'),
        gatewayYielded: this.portPlan?.gateway.yielded ?? false,
        consoleYielded: this.portPlan?.console.yielded ?? false,
        runMode: this.runMode,
        pgPort: this.pg.actualPort,
        pgEmbedded: this.pg.enabled,
        pgDataDir: this.pg.dataDir,
        healthTimeoutMs: this.config.restartPolicy.healthTimeoutMs,
        logsDir: this.about.logsDir,
        appVersion: this.about.appVersion,
      },
      at: this.deps.now(),
    }
  }

  /**
   * 端口计划文案投影（M9，docs §18.2）：gateway/console running 且机器层无更紧急
   * message 时，把计划 reason（让位说明/附加模式说明）铺到服务卡——沿用 pg 的
   * yielded message 语义（pg-service status()），状态页每服务如实分标
   * 「附加 / 自起 :N / 让位至 :N」（userStory 5）。db-down 引导等既有 message 优先。
   */
  private decoratePlacement(id: ManagedServiceId, status: ServiceStatus): ServiceStatus {
    const plan = this.portPlan
    if (plan === null) return status
    if (status.state !== 'running' || status.message !== null) return status
    const placement = plan[id]
    if (placement.mode === 'attach') return { ...status, message: placement.reason }
    if (placement.mode === 'spawn' && placement.yielded) {
      return { ...status, message: placement.reason }
    }
    return status
  }

  /** 单服务日志尾（D7「复制最近 400 行」——主进程侧读环形缓冲，不经快照）。 */
  logTail(id: ServiceId, n: number): string[] {
    if (id === 'pg') return this.pg.logTail(n)
    return this.supervisors[id].logTail(n)
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}
