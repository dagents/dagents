/**
 * llm-breaker —— HTTP LLM Provider 的连续失败熔断（稳定性专项 2026-10-04）。
 *
 * CLI-first 原则的另一面：HTTP Provider 是「可选加速」，加速器持续故障时
 * 不该把整个工作流拖死。熔断器按 providerId 记连续瞬时失败（网络/超时/
 * 429/5xx——配置错误 401/404 不计，那是需要人修的，静默换 CLI 只会掩盖）：
 *  - 连续失败 ≥ 阈值 → open，冷却窗内该 provider 的调用直接走 CLI 兜底
 *    （由 createDefaultLlmClient 决策，本模块只管状态）。
 *  - 冷却窗过后自动 half-open：放一个探测调用过 HTTP，成功即复位，
 *    失败即重开 —— 无需人工干预。
 *  - 任何成功都清零连续失败计数。
 *
 * 进程内单例（与 execution-registry 同一红线）；key 稳定（providerId），
 * provider 删除后残留条目无害（最多一行内存）。
 */

import { createLogger } from '@dagents/shared'
import { declareCounter, declareGauge } from './metrics.js'

const log = createLogger({ svc: 'gateway:llm-breaker' })

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const BREAKER_THRESHOLD = (): number => numEnv('LLM_HTTP_BREAKER_THRESHOLD', 3)
export const BREAKER_COOLDOWN_MS = (): number => numEnv('LLM_HTTP_BREAKER_COOLDOWN_MS', 60_000)

interface BreakerState {
  failures: number
  openedAt: number | null
}

const breakers = new Map<string, BreakerState>()

const openedTotal = declareCounter(
  'dagents_llm_breaker_opened_total',
  'HTTP LLM provider breaker opened (consecutive transient failures reached threshold)',
)
const fallbackTotal = declareCounter(
  'dagents_llm_breaker_fallback_total',
  'LLM calls served by the CLI fallback while the HTTP breaker was open',
)
declareGauge('dagents_llm_breaker_open', 'Number of HTTP LLM provider breakers currently open', {
  collect: () => countOpenBreakers(),
})

function stateOf(key: string): BreakerState {
  let st = breakers.get(key)
  if (!st) {
    st = { failures: 0, openedAt: null }
    breakers.set(key, st)
  }
  return st
}

/** 冷却窗过后返回 false（half-open：下一个调用是探测）。 */
export function isLlmCircuitOpen(key: string): boolean {
  const st = breakers.get(key)
  if (!st || st.openedAt == null) return false
  return Date.now() - st.openedAt < BREAKER_COOLDOWN_MS()
}

/** 熔断开启期间的 CLI 兜底计数（createDefaultLlmClient 调用）。 */
export function countLlmFallback(key: string): void {
  fallbackTotal.inc(1, { provider: key })
}

/** 瞬时失败（网络/超时/429/5xx）计数；达阈值（重）开。
 *  覆盖两种翻开场景：首次达阈值（openedAt 为 null），以及 half-open 探测
 *  失败（openedAt 已过期但 failures 仍在阈值上）——后者刷新 openedAt
 *  重新进入冷却。冷却窗内的重复失败不续期（反正调用已走 CLI）。 */
export function recordLlmFailure(key: string): void {
  const st = stateOf(key)
  st.failures += 1
  if (st.failures < BREAKER_THRESHOLD()) return
  const currentlyOpen = st.openedAt != null && Date.now() - st.openedAt < BREAKER_COOLDOWN_MS()
  if (currentlyOpen) return
  st.openedAt = Date.now()
  openedTotal.inc(1, { provider: key })
  log.warn('llm http breaker OPEN — falling back to CLI until cooldown', {
    providerId: key,
    failures: st.failures,
    cooldownMs: BREAKER_COOLDOWN_MS(),
  })
}

/** 成功复位（half-open 探测成功同样走这里）。 */
export function recordLlmSuccess(key: string): void {
  breakers.delete(key)
}

export function llmBreakerSnapshot(): Array<{
  providerId: string
  failures: number
  open: boolean
}> {
  return [...breakers.entries()].map(([providerId, st]) => ({
    providerId,
    failures: st.failures,
    open: st.openedAt != null && Date.now() - st.openedAt < BREAKER_COOLDOWN_MS(),
  }))
}

function countOpenBreakers(): number {
  return llmBreakerSnapshot().filter((b) => b.open).length
}

/** 测试隔离（生产代码禁用）。 */
export function resetLlmBreakerForTest(): void {
  breakers.clear()
}
