/**
 * run-gate —— run/chat 执行的并发上限闸（稳定性专项 2026-10-04）。
 *
 * 与 cli-spawn-gate 的分工：那边管「真子进程数」（排队等待），这边管
 * 「执行条目数」——Honest 429：新 run 达上限直接拒绝并明说，不排队。
 * 理由：异步 run 立即返回 runId，排队的 run 在用户视角是「已启动却永远
 * running」的谎言；拒绝 + 提示取消闲置运行，才是诚实背压。
 *
 * 覆盖路径：画布直跑（POST /workflows/:id/run）、chat @flow、chat inline
 * agent、断点续跑。gate 计数与 execution-registry 分离——registry 是控制
 * 通道真相源，gate 只管准入。
 */

import { createLogger } from '@dagents/shared'
import { declareCounter, declareGauge } from './metrics.js'

const log = createLogger({ svc: 'gateway:run-gate' })

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const MAX_CONCURRENT_RUNS = (): number => numEnv('DAGENTS_MAX_CONCURRENT_RUNS', 8)

let active = 0

declareGauge('dagents_runs_active', 'In-flight executions admitted by the run gate', {
  collect: () => active,
})
const rejectedTotal = declareCounter(
  'dagents_run_gate_rejected_total',
  'Executions rejected with 429 because the concurrent-run cap was reached',
)
/** run 启动计数——acquire 成功即 +1（与 finished{status} 成对，成功率的分子分母同源）。 */
export const runsStartedTotal = declareCounter(
  'dagents_runs_started_total',
  'Executions admitted by the run gate since process start',
)
/** run 终态计数——各执行路径 settle 时按终态打 label（completed/failed/cancelled/…）。 */
export const runsFinishedTotal = declareCounter(
  'dagents_runs_finished_total',
  'Executions settled, by terminal status',
  ['status'],
)

export interface RunGateStats {
  active: number
  max: number
}

export function runGateStats(): RunGateStats {
  return { active, max: MAX_CONCURRENT_RUNS() }
}

/**
 * 非阻塞取槽：满则返回 null（调用方回 429），绝不排队。
 * 返回的 release 幂等——与执行句柄的 finally 一起收口，重复调用无害。
 */
export function tryAcquireRunSlot(): (() => void) | null {
  if (active >= MAX_CONCURRENT_RUNS()) {
    rejectedTotal.inc()
    log.warn('run gate: concurrent run cap reached — rejecting', {
      active,
      max: MAX_CONCURRENT_RUNS(),
    })
    return null
  }
  active += 1
  runsStartedTotal.inc()
  let released = false
  return () => {
    if (released) return
    released = true
    active -= 1
  }
}

/** 执行路径 settle 时上报终态计数（与 release 配对调用）。 */
export function recordRunFinished(status: string): void {
  runsFinishedTotal.inc(1, { status })
}

/** 测试隔离（生产代码禁用）。 */
export function resetRunGateForTest(): void {
  active = 0
}
