/**
 * goals.ts — 目标看板（Goal Board）客户端模型（方向 C，2026-11-10）。
 *
 * 薄 fetch（ok 包络解包 + 非法状态码抛错，与 agents-catalog 同姿势）+
 * 纯派生（预算水位/轮次进度/下一步动作文案）——视图零逻辑。
 */

import { apiFetch } from '@/lib/api'

export type GoalStatus = 'active' | 'awaiting_eval' | 'achieved' | 'paused' | 'archived'

export interface Goal {
  id: string
  title: string
  description: string
  acceptance: string
  flowId: string | null
  flowName: string | null
  directoryId: string | null
  directoryName: string | null
  budgetUsd: number | null
  auto: boolean
  status: GoalStatus | string
  round: number
  maxRounds: number
  lastRunId: string | null
  lastEval: string | null
  lastEvalPassed: boolean | null
  createdAt: string
  updatedAt: string
  runCount: number
  totalCost: number
  lastRunStatus: string | null
  lastRunStartedAt: string | null
}

export interface GoalRun {
  runId: string
  status: string
  flowName: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  cost: number | null
}

export async function fetchGoals(): Promise<Goal[]> {
  const res = await apiFetch<{ goals: Goal[] }>('/api/goals', { method: 'GET' }, 'goals')
  return res.goals ?? []
}

export async function fetchGoalDetail(id: string): Promise<{ goal: Goal; runs: GoalRun[] }> {
  return apiFetch<{ goal: Goal; runs: GoalRun[] }>(
    `/api/goals/${encodeURIComponent(id)}`,
    { method: 'GET' },
    'goal detail',
  )
}

export interface GoalDraft {
  title: string
  description?: string
  acceptance?: string
  flowId?: string
  directoryId?: string
  budgetUsd?: number | null
  auto?: boolean
  maxRounds?: number
}

export async function createGoal(draft: GoalDraft): Promise<Goal> {
  const res = await apiFetch<{ goal: Goal }>(
    '/api/goals',
    { method: 'POST', body: JSON.stringify(draft) },
    'goal create',
  )
  return res.goal
}

export async function patchGoal(
  id: string,
  patch: Partial<GoalDraft> & { status?: 'active' | 'paused' | 'archived' },
): Promise<Goal> {
  const res = await apiFetch<{ goal: Goal }>(
    `/api/goals/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    'goal update',
  )
  return res.goal
}

export async function deleteGoal(id: string): Promise<void> {
  await apiFetch(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'goal delete')
}

/** 手动推进一轮（supervisor 的同一代码路径）；返回新 runId。 */
export async function advanceGoal(id: string): Promise<string> {
  const res = await apiFetch<{ runId: string }>(
    `/api/goals/${encodeURIComponent(id)}/advance`,
    { method: 'POST' },
    'goal advance',
  )
  return res.runId
}

// ─── 纯派生（视图免算） ───────────────────────────────────────────────

/** 预算已用比例（0-1；无预算 null）。 */
export function budgetFraction(g: Goal): number | null {
  if (g.budgetUsd == null || g.budgetUsd <= 0) return null
  return Math.min(1, g.totalCost / g.budgetUsd)
}

/** 轮次进度（0-1）。 */
export function roundFraction(g: Goal): number {
  return Math.min(1, g.round / Math.max(1, g.maxRounds))
}

export interface GoalNextAction {
  kind: 'running' | 'awaiting-eval' | 'advance' | 'resume' | 'achieved' | 'exhausted' | 'bind-flow'
  label: string
}

/** 目标卡的「下一动作」推断（纯函数，单测钉语义）。 */
export function nextActionOf(g: Goal): GoalNextAction {
  if (g.status === 'achieved') return { kind: 'achieved', label: '已达成' }
  if (!g.flowId) return { kind: 'bind-flow', label: '未绑定流程' }
  if (g.lastRunStatus === 'running' || g.lastRunStatus === 'awaiting_input') {
    return { kind: 'running', label: '本轮进行中' }
  }
  if (g.status === 'paused') {
    if (g.budgetUsd != null && g.budgetUsd > 0 && g.totalCost >= g.budgetUsd) {
      return { kind: 'exhausted', label: '预算耗尽·已暂停' }
    }
    if (g.round >= g.maxRounds) return { kind: 'exhausted', label: '轮次到顶·已暂停' }
    return { kind: 'resume', label: '已暂停·可恢复' }
  }
  // active：有未评估的终态 run → supervisor 会自动评估；否则可推进
  if (g.auto) {
    return g.lastRunId && g.lastEvalPassed == null && g.lastRunStatus
      ? { kind: 'awaiting-eval', label: '等待验收评估' }
      : { kind: 'advance', label: '自动推进中' }
  }
  return { kind: 'advance', label: '推一轮' }
}

export function formatGoalCost(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '<$0.01'
  return `$${v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')}`
}

/** run 终态 → 中文标签（与 FlowRunsPanel 的 STATUS_LABEL 同词表；goals 侧单源）。 */
export const RUN_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  running: '运行中',
  pending: '排队中',
  partial_success: '部分成功',
  budget_exceeded: '预算停机',
  awaiting_input: '等待输入',
}

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? status
}
