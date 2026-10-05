/**
 * cli-spawn-gate —— CLI 子进程并发闸（稳定性专项 2026-10-04）。
 *
 * 背景：PTY 会话有上限 8，但 CLI spawn（claude/codex…）没有总量护栏 ——
 * 并发 run × 分支节点并行，一次画布矩阵就能拉起几十个真进程把本机打爆。
 * 本模块是 gateway 侧所有 CLI spawn 的单一闸口（workflow-clients 的 LLM/
 * Agent 节点、inline-executor 的聊天路径、agent-invoke 的单发调用）。
 *
 * 语义：FIFO 排队等待（不拒绝——CLI 是基线执行引擎，等待优于失败）；
 * 等待超 5s 打 warn（背压可见）。每个 agent 进程自带 inactivity 看门狗
 * （300s 无输出收敛），闸内等待者不会永久排队——上游 run 总会结束。
 *
 * daemon / remote 型执行不经本闸（进程不在 gateway 侧起）。
 */

import { createLogger } from '@dagents/shared'
import { declareCounter, declareGauge } from './metrics.js'

const log = createLogger({ svc: 'gateway:cli-gate' })

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const MAX_CONCURRENT_CLI = (): number => numEnv('DAGENTS_MAX_CLI_PROCESSES', 16)

let active = 0
const waiters: Array<{ enqueueAt: number; proceed: () => void }> = []

declareGauge('dagents_cli_spawn_active', 'In-flight CLI child processes spawned by this gateway', {
  collect: () => active,
})
declareGauge('dagents_cli_spawn_waiting', 'Queued CLI spawns waiting for a slot', {
  collect: () => waiters.length,
})
const spawnTotal = declareCounter(
  'dagents_cli_spawn_total',
  'CLI child processes admitted through the spawn gate',
)

export interface CliSpawnGateStats {
  active: number
  waiting: number
  max: number
}

export function cliSpawnGateStats(): CliSpawnGateStats {
  return { active, waiting: waiters.length, max: MAX_CONCURRENT_CLI() }
}

/**
 * 取一个 CLI spawn 槽位，返回 release。等待期间只受「上游总会结束」约束；
 * 超时等待不在这里取消（调用方的 AbortSignal 由适配器在 spawn 后生效，
 * spawn 前取消的执行路径根本不会走到这里）。
 */
export async function acquireCliSlot(label: string): Promise<() => void> {
  spawnTotal.inc()
  if (active < MAX_CONCURRENT_CLI()) {
    active += 1
    return makeRelease()
  }
  const enqueueAt = Date.now()
  await new Promise<void>((resolve) => {
    waiters.push({ enqueueAt, proceed: resolve })
  })
  const waitedMs = Date.now() - enqueueAt
  if (waitedMs > 5_000) {
    log.warn('cli spawn gate: waited for slot (backpressure)', {
      label,
      waitedMs,
      max: MAX_CONCURRENT_CLI(),
    })
  }
  return makeRelease()
}

function makeRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = waiters.shift()
    if (next) {
      // 槽位直接移交：active 不减不加，等待者即刻持有
      next.proceed()
      return
    }
    active -= 1
  }
}

/** 测试隔离（生产代码禁用）。 */
export function resetCliSpawnGateForTest(): void {
  active = 0
  waiters.length = 0
}
