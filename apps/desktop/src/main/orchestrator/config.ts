import { existsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { isAbsolute, dirname, join } from 'node:path'
import type {
  DesktopConfig,
  ManagedServiceId,
  PostgresConfig,
  RestartPolicy,
  ServiceSpec,
} from './types'

// 配置加载/默认值/校验（docs §3.5 + §10.4）——零依赖手写校验（zod-lite），纯函数 + 注入 fs。
// 供应链纪律：desktop 零 runtime deps；复杂结构校验 20 行手写足够且可全测。

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxAttempts: 3,
  windowMs: 300_000,
  backoffMs: [1_000, 3_000, 9_000],
  healthTimeoutMs: 120_000,
}

/**
 * 默认端口（docs §18.4，M8）：8080/3000 与仓库默认一致——默认端口空闲即用，
 * 被陌生程序占时按形态分流（dev 诚实失败 / packaged 让位递增），由 port-plan 判定。
 * （旧 LOCKED_PORTS 端口锁退役：写非默认端口不再被拒，而是被接受为「钉死」——
 * 钉死端口被陌生程序占时两形态都诚实 failed 不让位，见 port-plan.ts。）
 */
export const DEFAULT_PORTS: Record<ManagedServiceId, number> = {
  gateway: 8080,
  console: 3000,
}

export const DEFAULT_PG_PORT = 55432

/** 端口计划注入的 env 键——extraEnv 写了这些键会被计划值覆盖（placement 单源）。 */
const PLACEMENT_ENV_KEYS = ['GATEWAY_PORT', 'PORT', 'GATEWAY_URL'] as const

export function defaultGatewaySpec(): ServiceSpec {
  return {
    command: 'pnpm',
    args: ['--filter', '@dagents/gateway', 'dev'],
    port: DEFAULT_PORTS.gateway,
    portExplicit: false,
  }
}

export function defaultConsoleSpec(): ServiceSpec {
  return {
    command: 'pnpm',
    args: ['--filter', '@dagents/console', 'dev'],
    port: DEFAULT_PORTS.console,
    portExplicit: false,
  }
}

export function defaultPostgresConfig(): PostgresConfig {
  return {
    embedded: true,
    // 默认 true 只对 packaged 形态生效——dev 形态由 Orchestrator 按 runMode 门控
    // 默认关（显式豁免依据本标记，supervisor.ts 构造器）。
    embeddedExplicit: false,
    port: DEFAULT_PG_PORT,
    dataDir: null,
    binDir: null,
    migrateScript: null,
    pgRequireRoot: null,
  }
}

export function defaultConfig(repoRoot: string): DesktopConfig {
  return {
    repoRoot,
    // '' = 由端口计划派生（http://localhost:<console 实际端口>，docs §18.2）；
    // 显式写值仍是接管 URL 的逃生门（附加/远程场景）——计划只在未写时接管。
    consoleUrl: '',
    mode: 'auto',
    services: {
      gateway: defaultGatewaySpec(),
      console: defaultConsoleSpec(),
    },
    restartPolicy: { ...DEFAULT_RESTART_POLICY, backoffMs: [...DEFAULT_RESTART_POLICY.backoffMs] },
    logTailLines: 400,
    extraEnv: {},
    postgres: defaultPostgresConfig(),
  }
}

/** 从 startDir 向上找 pnpm-workspace.yaml（dev 模式定位仓库根）；找不到回落 startDir。 */
export function discoverRepoRoot(startDir: string, exists: (p: string) => boolean = existsSync): string {
  let dir = startDir
  for (let i = 0; i < 20; i++) {
    if (exists(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const items = v.filter((x): x is string => typeof x === 'string' && x !== '')
  return items.length === v.length && items.length > 0 ? items : null
}

function asPositiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function mergeService(
  id: ManagedServiceId,
  raw: unknown,
  warnings: string[]
): ServiceSpec {
  const fallback = id === 'gateway' ? defaultGatewaySpec() : defaultConsoleSpec()
  if (raw === null || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>
  const spec: ServiceSpec = { ...fallback }

  const command = asString(obj.command)
  if (command) spec.command = command

  const args = asStringArray(obj.args)
  if (args) spec.args = args

  // 端口语义（docs §18.4，M8）：接受 1024–65535 合法端口；非默认值 = 钉死
  // （portExplicit——被陌生程序占时诚实 failed 不让位）；写默认值行为与不写一致
  // （旧 config「写 8080/3000」零变化；此前被拒的非默认值现在是超集放宽：接受+钉死）。
  const port = asPositiveInt(obj.port)
  if (port !== null) {
    if (port >= 1024 && port <= 65_535) {
      spec.port = port
      spec.portExplicit = port !== DEFAULT_PORTS[id]
    } else {
      warnings.push(
        `services.${id}.port=${port} 越界（1024–65535），已回落默认 ${DEFAULT_PORTS[id]}`
      )
    }
  }
  return spec
}

function mergeRestartPolicy(raw: unknown, warnings: string[]): RestartPolicy {
  const policy: RestartPolicy = { ...DEFAULT_RESTART_POLICY, backoffMs: [...DEFAULT_RESTART_POLICY.backoffMs] }
  if (raw === null || typeof raw !== 'object') return policy
  const obj = raw as Record<string, unknown>
  const maxAttempts = asPositiveInt(obj.maxAttempts)
  if (maxAttempts) policy.maxAttempts = Math.min(maxAttempts, 10)
  const windowMs = asPositiveInt(obj.windowMs)
  if (windowMs) policy.windowMs = Math.min(windowMs, 3_600_000)
  const healthTimeoutMs = asPositiveInt(obj.healthTimeoutMs)
  if (healthTimeoutMs) policy.healthTimeoutMs = Math.min(healthTimeoutMs, 600_000)
  if (Array.isArray(obj.backoffMs)) {
    const backoff = obj.backoffMs.filter(
      (x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= 60_000
    )
    if (backoff.length > 0) policy.backoffMs = backoff
  }
  if (policy.maxAttempts < 1) policy.maxAttempts = 1
  void warnings
  return policy
}

/**
 * postgres.* 合并（docs §10.4 三层「不抢连接」中的第 ② 层在此落定）：
 * extraEnv.POSTGRES_URL 已设（用户指向外部 PG，含 15432 docker）→ embedded 自动 false + warning。
 */
function mergePostgres(
  raw: unknown,
  extraEnv: Record<string, string>,
  warnings: string[]
): PostgresConfig {
  const pg = defaultPostgresConfig()
  if (extraEnv.POSTGRES_URL !== undefined) {
    pg.embedded = false
    warnings.push(
      `extraEnv.POSTGRES_URL 已设置（${extraEnv.POSTGRES_URL}）——内嵌 Postgres 自动关闭，gateway 连用户指定的外部库（不抢连接）`
    )
  }
  if (raw === null || typeof raw !== 'object') return pg
  const obj = raw as Record<string, unknown>

  const embedded = asBool(obj.embedded)
  if (embedded !== null) {
    pg.embedded = embedded
    // 显式设置标记：dev 模式「默认不启用内嵌 PG」的唯一豁免依据（AC-7④）
    pg.embeddedExplicit = true
  } else if (obj.embedded !== undefined) {
    warnings.push('postgres.embedded 非 boolean，已回落默认 true')
  }

  // PG 端口可配语义保留（docs §18.4）：只做合法范围校验，作为让位探测的起点端口
  const port = asPositiveInt(obj.port)
  if (port !== null) {
    if (port >= 1024 && port <= 65_535) pg.port = port
    else warnings.push(`postgres.port=${obj.port} 越界（1024–65535），已回落默认 ${DEFAULT_PG_PORT}`)
  }

  for (const field of ['dataDir', 'binDir', 'migrateScript', 'pgRequireRoot'] as const) {
    const v = asString(obj[field])
    if (v === null) {
      if (obj[field] !== undefined) warnings.push(`postgres.${field} 非非空字符串，已回落运行时默认`)
      continue
    }
    if (!isAbsolute(v)) {
      warnings.push(`postgres.${field}="${v}" 非绝对路径，已回落运行时默认`)
      continue
    }
    pg[field] = v
  }
  return pg
}

export interface LoadConfigDeps {
  readFileSync: (path: string) => string
  existsSync: (path: string) => boolean
}

export interface LoadConfigResult {
  config: DesktopConfig
  warnings: string[]
}

/**
 * 加载 userData/config.json 并与全量默认值合并。
 * 坏 JSON / 未知字段 / 类型不符 → 逐项回落默认值并记录 warning，永不抛出。
 */
export function loadConfig(
  opts: {
    userDataDir: string
    startDir: string
    deps?: LoadConfigDeps
  }
): LoadConfigResult {
  const deps = opts.deps ?? {
    readFileSync: (p: string) => fsReadFileSync(p, 'utf-8'),
    existsSync,
  }
  const warnings: string[] = []
  const config = defaultConfig(discoverRepoRoot(opts.startDir))

  const configPath = join(opts.userDataDir, 'config.json')
  let raw: unknown = null
  if (deps.existsSync(configPath)) {
    try {
      raw = JSON.parse(deps.readFileSync(configPath))
    } catch (e) {
      warnings.push(`config.json 解析失败（${e instanceof Error ? e.message : String(e)}），已回落全量默认值`)
    }
  }
  if (raw === null || typeof raw !== 'object') {
    if (raw !== null) warnings.push('config.json 顶层不是对象，已回落全量默认值')
    return { config, warnings }
  }
  const obj = raw as Record<string, unknown>

  const repoRoot = asString(obj.repoRoot)
  if (repoRoot) config.repoRoot = repoRoot

  const consoleUrl = asString(obj.consoleUrl)
  if (consoleUrl && /^https?:\/\//.test(consoleUrl)) {
    config.consoleUrl = consoleUrl
    warnings.push(
      `consoleUrl 已显式设置（${consoleUrl}）——接管 URL 以它为准，端口计划的让位派生值不生效（docs §18.2）`
    )
  } else if (consoleUrl) {
    warnings.push(`consoleUrl "${consoleUrl}" 非 http(s) URL，已回落端口计划派生值`)
  }

  const mode = asString(obj.mode)
  if (mode === 'auto' || mode === 'dev' || mode === 'packaged') config.mode = mode
  else if (mode !== null) warnings.push(`mode "${mode}" 非 auto/dev/packaged，已回落默认 auto`)

  config.services = {
    gateway: mergeService('gateway', (obj.services as Record<string, unknown> | undefined)?.gateway, warnings),
    console: mergeService('console', (obj.services as Record<string, unknown> | undefined)?.console, warnings),
  }
  config.restartPolicy = mergeRestartPolicy(obj.restartPolicy, warnings)

  const logTailLines = asPositiveInt(obj.logTailLines)
  if (logTailLines) config.logTailLines = Math.min(Math.max(logTailLines, 50), 2000)

  if (obj.extraEnv !== null && typeof obj.extraEnv === 'object' && !Array.isArray(obj.extraEnv)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj.extraEnv as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v
    }
    config.extraEnv = env
    // placement 单源（docs §18.2）：端口计划的 env 注入后于 extraEnv 展开——写了
    // 这些键的用户值会被实际端口覆盖，提前告警防「env 旁路制造半残态」的误解。
    for (const key of PLACEMENT_ENV_KEYS) {
      if (env[key] !== undefined) {
        warnings.push(
          `extraEnv.${key} 与端口计划注入冲突——spawn 时以编排器探测的实际端口为准（extraEnv 值不生效）`
        )
      }
    }
  }

  // postgres.* 在 extraEnv 之后合并（第 ② 层回退依赖 extraEnv.POSTGRES_URL 判定）
  config.postgres = mergePostgres(obj.postgres, config.extraEnv, warnings)

  // 未知字段忽略（向前兼容）
  return { config, warnings }
}
