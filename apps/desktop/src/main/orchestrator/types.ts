// 编排器共享类型 —— 主进程/preload/渲染页三方的单一契约（零依赖纯类型）。
// 状态机语义见 state-machine.ts；docs/desktop-architecture.md §3.2 + §10（内嵌 PG）。

export type ServiceId = 'gateway' | 'console' | 'pg'

/** config.services 的键——pg 不走 ServiceSpec（其二进制/数据目录/端口让位在 postgres.* 另述）。 */
export type ManagedServiceId = Exclude<ServiceId, 'pg'>

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
  /**
   * 默认端口 8080/3000（docs §18.4）：空闲即用；被陌生程序占时按形态分流
   * （dev 诚实失败 / packaged 让位递增），判定在 port-plan.ts。
   */
  port: number
  /**
   * config.json 是否显式钉死了非默认端口（运行时派生标记，同 postgres.embeddedExplicit
   * 先例）：钉死端口被陌生程序占时两形态都诚实 failed 不让位。
   */
  portExplicit: boolean
}

/** 实际 spawn 规格（supervisor 消费；packaged 形态由 run-mode.ts 运行时构造）。 */
export interface ServiceRunSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** 内嵌 Postgres 配置（docs §10 + §18.4：port 是让位探测起点，分配判定在 port-plan）。 */
export interface PostgresConfig {
  /** 内嵌 PG 总开关；false = 外部 Postgres（gateway 走 .env/extraEnv 的 POSTGRES_URL）。 */
  embedded: boolean
  /**
   * embedded 是否为 config.json 显式设置（运行时派生字段，不参与序列化）：
   * dev 模式默认不启用内嵌 PG（防 dev 用户外部/docker 库被静默切到空内嵌库），
   * 显式 embedded:true/false 是唯一豁免依据——loadConfig 按原始 JSON 是否含该键标记。
   */
  embeddedExplicit: boolean
  /** 默认端口 55432（避开 5432 原生 / 15432 infra docker）；被占自动 +1 让位（≤20 次）。 */
  port: number
  /** PG 数据目录；null = 运行时默认 <userData>/pgdata。 */
  dataDir: string | null
  /** 二进制 bin 目录（含 initdb/postgres/pg_ctl）；null = 运行时默认 <desktop>/stage/pg/native/bin。 */
  binDir: string | null
  /** migrate.mjs 路径；null = 运行时默认 <repoRoot>/packages/db/scripts/migrate.mjs。 */
  migrateScript: string | null
  /** pg 驱动（建库用）解析根；null = 运行时默认 <repoRoot>/packages/db。 */
  pgRequireRoot: string | null
}

export interface DesktopConfig {
  repoRoot: string
  /**
   * 接管 URL 逃生门：''（默认）= 由端口计划派生 http://localhost:<console 实际端口>
   * （docs §18.2 单一事实源）；显式 http(s) URL = 用户钉死接管目标（附加/远程场景）。
   */
  consoleUrl: string
  /** 运行形态意图：auto=按内嵌栈在位探测（默认）；dev/packaged=显式钉死（docs §11.4）。 */
  mode: 'auto' | 'dev' | 'packaged'
  services: Record<ManagedServiceId, ServiceSpec>
  restartPolicy: RestartPolicy
  logTailLines: number
  /** spawn 时附加注入的环境变量（R3：桌面启动环境 PATH 差异的逃生门）。 */
  extraEnv: Record<string, string>
  postgres: PostgresConfig
}

/** 面向渲染层的服务状态（machine 内部字段过滤后的投影）。 */
export interface ServiceStatus {
  id: ServiceId
  state: ServiceState
  /** true = 端口已被外部实例占用，本 app 未 spawn 只做健康观察。 */
  attachMode: boolean
  /** gateway /health 的 db 字段子状态；console/pg 恒 unknown。 */
  db: 'up' | 'down' | 'unknown'
  /** 当前滑动窗口内已用重启次数。 */
  attempts: number
  lastExit: { code: number | null } | null
  startedAt: number | null
  /** 引导/说明文案（db-down 指引、退避提示、预算耗尽等）。 */
  message: string | null
}

/** 内容意愿态（docs §12.2，M7 死路根治）：auto=自动接管；boot=钉住启动态页；
 * console=用户意愿进工作台（不健康时保留，恢复即接管）。 */
export type ContentIntent = 'auto' | 'boot' | 'console'

/** 渲染层快照（preload 窄暴露面 getState/onState 的载荷）。 */
export interface DesktopSnapshot {
  /** boot = 阶段 A 启动态页；console = 阶段 B 已接管工作台（M3）。 */
  phase: 'boot' | 'console'
  /** 窗口内容意愿（takeover 控制器维护，index.ts 合入快照——「已钉住」徽标数据源）。 */
  contentIntent: ContentIntent
  services: Record<ServiceId, ServiceStatus>
  logTail: Record<ServiceId, string[]>
  config: {
    repoRoot: string
    consoleUrl: string
    gatewayPort: number
    consolePort: number
    /**
     * gateway/console 是否让位（实际端口 ≠ 默认，docs §18.2）：渲染层让位黄 chip
     * 与「实际端口」文案的数据源（pg 沿用既有 message 判定——pgPortChip）。
     * 字段只增不改语义（R23：preload 窄暴露面契约）。
     */
    gatewayYielded: boolean
    consoleYielded: boolean
    /** 实际运行形态（状态页明示：安装包内嵌栈 / 仓库 dev 栈）。 */
    runMode: 'dev' | 'packaged'
    /** 内嵌 PG 实际端口（让位后 ≠ 配置默认；null = 未启用/未解析）。 */
    pgPort: number | null
    /** 内嵌 PG 是否启用（false = 外部 Postgres）。 */
    pgEmbedded: boolean
    /** 内嵌 PG 数据目录（README 卸载保留策略的落点）。 */
    pgDataDir: string
    /** 健康等待预算（restartPolicy.healthTimeoutMs 运行时值——渲染层文案不写死 120s）。 */
    healthTimeoutMs: number
    /** 子进程日志目录（userData/logs；「打开完整日志」目标）。 */
    logsDir: string
    /** 应用版本（app.getVersion()；关于面板/状态页 footer）。 */
    appVersion: string
  }
  at: number
}
