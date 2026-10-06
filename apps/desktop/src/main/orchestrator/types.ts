// 编排器共享类型 —— 主进程/preload/渲染页三方的单一契约（零依赖纯类型）。
// 状态机语义见 state-machine.ts；docs/desktop-architecture.md §3.2。

export type ServiceId = 'gateway' | 'console'

/** 单服务状态机状态集（idle→starting→waiting_health→running→restarting→failed/stopped）。 */
export type ServiceState =
  | 'idle'
  | 'starting'
  | 'waiting_health'
  | 'running'
  | 'restarting'
  | 'failed'
  | 'stopped'

/** 有界重启策略（docs/desktop-architecture.md §3.2 规则 1）。 */
export interface RestartPolicy {
  /** 滑动窗口内最大重启次数。 */
  maxAttempts: number
  /** 窗口长度（ms）。 */
  windowMs: number
  /** 第 n 次重启前的退避（索引 = 已重启次数，越界取末位）。 */
  backoffMs: number[]
  /** waiting_health/running 阶段健康持续失败到判定「意外退出」的期限。 */
  healthTimeoutMs: number
}

export interface ServiceSpec {
  command: string
  args: string[]
  /** 端口锁 8080/3000（console BFF 只认 GATEWAY_URL——AGENTS.md 已知问题）。 */
  port: number
}

export interface DesktopConfig {
  repoRoot: string
  consoleUrl: string
  services: Record<ServiceId, ServiceSpec>
  restartPolicy: RestartPolicy
  logTailLines: number
  /** spawn 时附加注入的环境变量（R3：桌面启动环境 PATH 差异的逃生门）。 */
  extraEnv: Record<string, string>
}

/** 面向渲染层的服务状态（machine 内部字段过滤后的投影）。 */
export interface ServiceStatus {
  id: ServiceId
  state: ServiceState
  /** true = 端口已被外部实例占用，本 app 未 spawn 只做健康观察。 */
  attachMode: boolean
  /** gateway /health 的 db 字段子状态；console 恒 unknown。 */
  db: 'up' | 'down' | 'unknown'
  /** 当前滑动窗口内已用重启次数。 */
  attempts: number
  lastExit: { code: number | null } | null
  startedAt: number | null
  /** 引导/说明文案（db-down 指引、退避提示、预算耗尽等）。 */
  message: string | null
}

/** 渲染层快照（preload 窄暴露面 getState/onState 的载荷）。 */
export interface DesktopSnapshot {
  /** boot = 阶段 A 启动态页；console = 阶段 B 已接管工作台（M3）。 */
  phase: 'boot' | 'console'
  services: Record<ServiceId, ServiceStatus>
  logTail: Record<ServiceId, string[]>
  config: {
    repoRoot: string
    consoleUrl: string
    gatewayPort: number
    consolePort: number
  }
  at: number
}
