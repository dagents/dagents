import type { RunMode } from './run-mode'
import {
  classifyConsoleIdentity,
  classifyGatewayIdentity,
  probeUrl,
  type PortIdentity,
} from './identity'
import type { HttpResult } from './supervisor'
import type { ManagedServiceId, ServiceId } from './types'

// 端口分配计划（docs/desktop-architecture.md §18.1/§18.2，M8）——三服务同构
// 「默认端口空闲即用、被占按身份分流、候选递增探测（≤PORT_MAX_TRIES，与 pg 现有
// 让位机制同构）、耗尽诚实 failed」。以 pg 的 pickPgPort（原 pg-service.ts）为模板
// 平移推广；一切探测经 PlanPortDeps 注入（复用 SupervisorDeps 的 isPortOpen/httpGet
// 通道），纯函数层零 electron、可全测（purity.test.ts 守护）。
//
// 分配结果 PortPlan 是实际端口的单一事实源：进 env 注入（GATEWAY_PORT/PORT/
// GATEWAY_URL/POSTGRES_URL DSN）、进快照、进日志、进窗口接管 URL（§18.2）。
// 依赖方向（§18.1）：gateway 判 attach → pg skipped（外部栈自带数据库）；
// console 的 GATEWAY_URL ← plan.gatewayUrl；gateway 的 POSTGRES_URL ← plan.pg。

/** 候选探测上限（默认端口 + 其后 +1..+19，共 20 个端口，与 pg 让位先例同构）。 */
export const PORT_MAX_TRIES = 20
/** 身份问询超时（dev console 冷编译 4-15s 窗口，§18.3/R16）。 */
export const IDENTITY_TIMEOUT_MS = 10_000
/** 身份问询次数（10s 超时 + 1 重试，最坏 20s；仅启动路径一次）。 */
export const IDENTITY_ATTEMPTS = 2

export type ServicePlacementMode = 'spawn' | 'attach' | 'failed'

export interface ServicePlacement {
  mode: ServicePlacementMode
  /** 实际端口（spawn/attach=监听端口；failed=期望端口，仅诊断用）。 */
  port: number
  /** 实际端口 ≠ 默认端口（让位明示，沿用 pg yielded 文案语义）。 */
  yielded: boolean
  /** 状态页/日志文案（attach 标记 / 让位说明 / failed 原因）。 */
  reason: string | null
}

/** pg 无 attach 分支（§18.1）：spawn 于让位端口，或诚实 failed；null = 不启动。 */
export type PgPlacement =
  { mode: 'spawn'; port: number; yielded: boolean } | { mode: 'failed'; reason: string }

export interface PortPlan {
  runMode: RunMode
  gateway: ServicePlacement
  console: ServicePlacement
  /** null = 不启动内嵌 PG（gateway 附加 / postgres.embedded=false）。 */
  pg: PgPlacement | null
  /** 派生：console BFF 与下游单源的 gateway 地址（附加实例或自起实例）。 */
  gatewayUrl: string
  /** 派生：窗口接管唯一 URL 源（takeover/导航防护/菜单全读这里）。 */
  consoleUrl: string
}

export interface ServicePortInput {
  /** 默认端口（或 config 钉死端口）。 */
  preferred: number
  /** config 显式钉死（services.<id>.port 写了非默认值）——被陌生程序占即诚实 failed，不让位。 */
  pinned: boolean
}

export interface PlanPortInput {
  runMode: RunMode
  gateway: ServicePortInput
  console: ServicePortInput
  pg: { preferred: number; enabled: boolean }
}

export interface PlanPortDeps {
  isPortOpen(port: number): Promise<boolean>
  httpGet(url: string, timeoutMs: number): Promise<HttpResult>
  log(id: ServiceId, line: string): void
}

/**
 * 求三服务端口计划（§18.1 矩阵）：
 *   端口无人听           → spawn 于默认（yielded=false）
 *   端口开且身份=dagents  → attach（仅 gateway/console；pg 无此分支）
 *   端口开但是陌生监听者  → 钉死：诚实 failed；dev：诚实 failed+指引；packaged：+1 递增让位
 *   候选全占             → 诚实 failed（不猜不抢）
 * gateway 附加 → pg null（skipped）；pg enabled=false → null。
 */
export async function planPortAllocation(
  input: PlanPortInput,
  deps: PlanPortDeps,
): Promise<PortPlan> {
  const gateway = await planServicePlacement('gateway', input.gateway, input.runMode, deps)
  const consolePlacement = await planServicePlacement('console', input.console, input.runMode, deps)
  const pg =
    gateway.mode === 'attach' || !input.pg.enabled
      ? null
      : await planPgPlacement(input.pg.preferred, input.runMode, deps)
  return {
    runMode: input.runMode,
    gateway,
    console: consolePlacement,
    pg,
    gatewayUrl: `http://localhost:${gateway.port}`,
    consoleUrl: `http://localhost:${consolePlacement.port}`,
  }
}

/** gateway/console 共用矩阵（差异只在身份判别特征——classify* 按服务取）。 */
async function planServicePlacement(
  id: ManagedServiceId,
  spec: ServicePortInput,
  runMode: RunMode,
  deps: PlanPortDeps,
): Promise<ServicePlacement> {
  const preferred = spec.preferred
  if (!(await deps.isPortOpen(preferred))) {
    return { mode: 'spawn', port: preferred, yielded: false, reason: null }
  }
  const identity = await probeListenerIdentity(id, preferred, deps)
  if (identity === 'dagents') {
    return {
      mode: 'attach',
      port: preferred,
      yielded: false,
      reason: '附加模式（端口上是 dagents 实例——不 spawn、不代杀、退出不误杀）',
    }
  }
  if (spec.pinned) {
    return failedPlacement(
      preferred,
      `端口 ${preferred} 被非 dagents 程序占用，而 config 已钉死该端口（services.${id}.port=${preferred}）——不让位；请停掉占用进程或改钉其他端口`,
    )
  }
  if (runMode === 'dev') {
    return failedPlacement(
      preferred,
      `dev 形态固定端口 ${preferred} 被非 dagents 程序占用——不让位（不扰动 pnpm dev/e2e/restart-gateway.sh 等仓库工具链）；请腾出端口后点「重试服务」，或改用 packaged 形态（自动让位）`,
    )
  }
  // packaged：+1 递增探测空闲候选（默认端口已探明被占，从 +1 起；上限与 pg 同构）
  for (let i = 1; i < PORT_MAX_TRIES; i++) {
    const port = preferred + i
    if (!(await deps.isPortOpen(port))) {
      return {
        mode: 'spawn',
        port,
        yielded: true,
        reason: `端口 :${port}（默认 ${preferred} 被占用，已让位）`,
      }
    }
  }
  return failedPlacement(
    preferred,
    `端口 ${preferred}–${preferred + PORT_MAX_TRIES - 1} 全被占用——${id} 无处可听；请释放其一或改 services.${id}.port 钉死其他端口`,
  )
}

/**
 * pg 矩阵（无身份判别/无 attach）：dev 固定端口不让位（§18.4）；
 * packaged 递增让位（pickPgPort 原语义平移）；耗尽诚实 failed。
 */
async function planPgPlacement(
  preferred: number,
  runMode: RunMode,
  deps: PlanPortDeps,
): Promise<PgPlacement> {
  if (runMode === 'dev') {
    if (await deps.isPortOpen(preferred)) {
      return {
        mode: 'failed',
        reason: `dev 形态固定端口 ${preferred} 已被占用——内嵌 Postgres 不让位（不扰动仓库工具链）；请腾出端口或改用 packaged 形态`,
      }
    }
    return { mode: 'spawn', port: preferred, yielded: false }
  }
  for (let i = 0; i < PORT_MAX_TRIES; i++) {
    const port = preferred + i
    if (!(await deps.isPortOpen(port))) return { mode: 'spawn', port, yielded: i > 0 }
  }
  return {
    mode: 'failed',
    reason: `端口 ${preferred}–${preferred + PORT_MAX_TRIES - 1} 全被占用——内嵌 Postgres 无处可听，请释放其一或改 postgres.port`,
  }
}

/**
 * 身份问询（§18.3）：TCP 已开才调用；10s 超时 + 1 重试兜 dev console 冷编译窗口；
 * 无应答按 stranger 安全默认（只有 dagents 协议特征才放行附加）。
 */
async function probeListenerIdentity(
  id: ManagedServiceId,
  port: number,
  deps: PlanPortDeps,
): Promise<PortIdentity> {
  for (let attempt = 1; attempt <= IDENTITY_ATTEMPTS; attempt++) {
    const res = await deps.httpGet(probeUrl(id, port), IDENTITY_TIMEOUT_MS)
    if (!('error' in res)) {
      return id === 'gateway' ? classifyGatewayIdentity(res) : classifyConsoleIdentity(res)
    }
    if (attempt < IDENTITY_ATTEMPTS) {
      deps.log(
        id,
        `端口 ${port} 身份问询失败（${res.error}），重试 ${attempt + 1}/${IDENTITY_ATTEMPTS}…`,
      )
    } else {
      deps.log(
        id,
        `端口 ${port} 身份问询无应答（${res.error}）——按陌生程序处理（只有 dagents 协议特征才附加）`,
      )
    }
  }
  return 'stranger'
}

function failedPlacement(preferred: number, reason: string): ServicePlacement {
  return { mode: 'failed', port: preferred, yielded: false, reason }
}
