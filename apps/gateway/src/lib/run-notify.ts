/**
 * run-notify —— run 终态通知的发射单点 + 进程内幂等 claim（R9b，
 * design-sharp §2.2；载体 = 激活 ws.ts 预留的 `run-updated` 帧 + ws-hub
 * 扩 runId 订阅维度）。
 *
 * claim 语义边界（诚实）：进程内 Set<runId> = 单进程 claim——首发射即
 * claim，重复调用静默；gateway 重启后 Set 清零，但重启意味着无新终态产生
 * （run 已被 boot sweep 收敛、此后无二次发射请求），重启窗口不构成双通知
 * 面。与 execution-registry 同款单进程取舍（ADR：挂起/registry 纯内存红线
 * docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md）。
 *
 * superseded 抑制（衔接 R3，AC-R9-3 后半）：stopReason === 'superseded'
 * 直接 return 零发射——服务端为主（客户端过滤是兜底）。
 *
 * 发射范围 = 画布直跑 / resume / answer / trial 路径；chat @flow 走既有
 * chat:done 帧不重复接（chat 域通知已存在，避免双通知）。
 */
import { wsHub } from '../ws-hub.js'

/** 已发射过终态通知的 runId（进程内幂等 claim）。 */
const notifiedRuns = new Set<string>()

/** 终态词表（帧 status ∈ 终态即「run 完成」信号；awaiting_input 不算完成）。 */
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'partial_success',
  'budget_exceeded',
  'stopped',
  'cancelled', // 存量词（R3 写新读旧双读期）
])

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** 测试钩子：重置 claim 状态（隔离用例间幂等语义）。 */
export function resetRunNotifyClaimForTests(): void {
  notifiedRuns.clear()
}

export interface RunFinishedParams {
  runId: string
  flowId?: string
  status: string
  /** 与 R3 runEnd 帧同词表（user/interrupted/superseded/model/provider）。 */
  stopReason?: string
}

/**
 * 发射 run 终态通知（幂等 claim：同 runId 至多一次；superseded 零发射）。
 * 非终态 status（如 awaiting_input）静默跳过——不算「完成」。
 */
export function notifyRunFinished(params: RunFinishedParams): void {
  if (params.stopReason === 'superseded') return
  if (!isTerminalRunStatus(params.status)) return
  if (notifiedRuns.has(params.runId)) return
  notifiedRuns.add(params.runId)
  wsHub.broadcastRun(params.runId, {
    type: 'run-updated',
    runId: params.runId,
    ...(params.flowId ? { flowId: params.flowId } : {}),
    status: params.status,
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
  })
}
