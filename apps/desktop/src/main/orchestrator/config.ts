import { existsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DesktopConfig, RestartPolicy, ServiceId, ServiceSpec } from './types'

// 配置加载/默认值/校验（docs §3.5）——零依赖手写校验（zod-lite），纯函数 + 注入 fs。
// 供应链纪律：desktop 零 runtime deps；复杂结构校验 20 行手写足够且可全测。

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxAttempts: 3,
  windowMs: 300_000,
  backoffMs: [1_000, 3_000, 9_000],
  healthTimeoutMs: 120_000,
}

export const LOCKED_PORTS: Record<ServiceId, number> = {
  gateway: 8080,
  console: 3000,
}

const PORT_LOCK_REASON =
  '端口锁定 8080/3000（console BFF 只认 GATEWAY_URL——AGENTS.md 已知问题），已回落默认端口'

export function defaultGatewaySpec(): ServiceSpec {
  return { command: 'pnpm', args: ['--filter', '@dagents/gateway', 'dev'], port: 8080 }
}

export function defaultConsoleSpec(): ServiceSpec {
  return { command: 'pnpm', args: ['--filter', '@dagents/console', 'dev'], port: 3000 }
}

export function defaultConfig(repoRoot: string): DesktopConfig {
  return {
    repoRoot,
    consoleUrl: 'http://localhost:3000',
    services: {
      gateway: defaultGatewaySpec(),
      console: defaultConsoleSpec(),
    },
    restartPolicy: { ...DEFAULT_RESTART_POLICY, backoffMs: [...DEFAULT_RESTART_POLICY.backoffMs] },
    logTailLines: 400,
    extraEnv: {},
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

function mergeService(
  id: ServiceId,
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

  // 端口锁（约束 5）：schema 保留 port 字段但只接受默认值，其余回落并告警
  const port = asPositiveInt(obj.port)
  if (port !== null && port !== LOCKED_PORTS[id]) {
    warnings.push(`services.${id}.port=${port} 被拒绝：${PORT_LOCK_REASON}`)
  }
  spec.port = LOCKED_PORTS[id]
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
  if (consoleUrl && /^https?:\/\//.test(consoleUrl)) config.consoleUrl = consoleUrl
  else if (consoleUrl) warnings.push(`consoleUrl "${consoleUrl}" 非 http(s) URL，已回落默认值`)

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
  }

  // 未知字段忽略（向前兼容）
  return { config, warnings }
}
