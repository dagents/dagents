'use client'

/**
 * GoalsView — 目标看板（Goal Board，方向 C，2026-11-10）。
 *
 * 「为同一目标不断前进」的操作面：目标卡（轮次/预算水位/下一动作/上轮
 * 评估结论）+ 创建对话框（目标/验收标准/绑定流程与目录/预算/auto）+
 * 手动动作（推一轮 = supervisor 同一代码路径、暂停/恢复、删除）。
 * 卡片展开显示轮次谱系（run 行 + 时长条——方向 D 的多 run 对比最小形态）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n'
import {
  fetchGoals,
  fetchGoalDetail,
  createGoal,
  patchGoal,
  deleteGoal,
  advanceGoal,
  budgetFraction,
  roundFraction,
  nextActionOf,
  formatGoalCost,
  type Goal,
  type GoalRun,
} from '@/lib/goals'
import { runStatusLabel } from '@/lib/goals'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { SkeletonList } from '@/components/skeleton'
import '@/styles/goals.css'

const POLL_MS = 5000

interface FlowOption {
  id: string
  name: string
}

function durationLabel(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`
}

// ─── 单张目标卡 ───────────────────────────────────────────────────────

function GoalCard({
  goal,
  onAdvance,
  onToggleAuto,
  onPatchStatus,
  onDelete,
  busy,
}: {
  goal: Goal
  onAdvance: (g: Goal) => void
  onToggleAuto: (g: Goal) => void
  onPatchStatus: (g: Goal, status: 'active' | 'paused' | 'archived') => void
  onDelete: (g: Goal) => void
  busy: boolean
}): React.ReactElement {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [runs, setRuns] = useState<GoalRun[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const loadedRef = useRef<string | null>(null)

  const action = nextActionOf(goal)
  const budget = budgetFraction(goal)
  const rounds = roundFraction(goal)
  const maxDur = useMemo(
    () => Math.max(1, ...(runs ?? []).map((r) => r.durationMs ?? 0)),
    [runs],
  )

  useEffect(() => {
    if (!expanded || loadedRef.current === goal.id) return
    loadedRef.current = goal.id
    void fetchGoalDetail(goal.id)
      .then((d) => setRuns(d.runs ?? []))
      .catch((e: Error) => setRunsError(e.message))
  }, [expanded, goal.id])

  const statusTone =
    goal.status === 'achieved'
      ? 'achieved'
      : goal.status === 'paused'
        ? 'paused'
        : action.kind === 'running'
          ? 'running'
          : 'active'

  return (
    <div className={`goal-card ${statusTone}`}>
      <div className="goal-card-head">
        <div className="goal-card-title-wrap">
          <h3 className="goal-card-title" title={goal.description}>{goal.title}</h3>
          <span className={`goal-status-badge ${statusTone}`}>
            {goal.status === 'achieved'
              ? t('已达成')
              : goal.status === 'paused'
                ? t('已暂停')
                : action.kind === 'running'
                  ? t('本轮进行中')
                  : t('推进中')}
            {goal.auto && goal.status !== 'achieved' ? ` · ${t('自动')}` : ''}
          </span>
        </div>
        <div className="goal-card-actions">
          {goal.status !== 'achieved' && goal.status !== 'archived' ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || action.kind === 'running' || action.kind === 'bind-flow'}
                onClick={() => onAdvance(goal)}
                title={action.kind === 'bind-flow' ? t('先在编辑里绑定流程') : t('按目标推进一轮（supervisor 同一代码路径）')}
              >
                {t('推一轮')}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onToggleAuto(goal)}>
                {goal.auto ? t('停自动') : t('开自动')}
              </button>
              {goal.status === 'active' ? (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onPatchStatus(goal, 'paused')}>
                  {t('暂停')}
                </button>
              ) : (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onPatchStatus(goal, 'active')}>
                  {t('恢复')}
                </button>
              )}
            </>
          ) : null}
          <button type="button" className="btn btn-secondary goal-btn-danger" disabled={busy} onClick={() => onDelete(goal)}>
            {t('删除')}
          </button>
        </div>
      </div>

      <div className="goal-card-progress">
        <div className="goal-progress-row">
          <span className="goal-progress-label">{t('轮次')}</span>
          <div className="goal-progress-track">
            <div className="goal-progress-fill rounds" style={{ width: `${Math.round(rounds * 100)}%` }} />
          </div>
          <span className="goal-progress-value">
            {goal.round} / {goal.maxRounds}
          </span>
        </div>
        {budget != null ? (
          <div className="goal-progress-row">
            <span className="goal-progress-label">{t('预算')}</span>
            <div className="goal-progress-track">
              <div
                className={`goal-progress-fill budget${budget >= 1 ? ' exhausted' : budget > 0.8 ? ' warn' : ''}`}
                style={{ width: `${Math.round(budget * 100)}%` }}
              />
            </div>
            <span className="goal-progress-value">
              {formatGoalCost(goal.totalCost)} / {formatGoalCost(goal.budgetUsd ?? 0)}
            </span>
          </div>
        ) : (
          <div className="goal-progress-row">
            <span className="goal-progress-label">{t('已投入')}</span>
            <span className="goal-progress-value">
              {formatGoalCost(goal.totalCost)} · {goal.runCount} {t('轮')}
            </span>
          </div>
        )}
      </div>

      <div className="goal-card-meta">
        <span className="goal-next-action">{action.label}</span>
        {goal.flowName ? (
          <Link href={`/workflows/${goal.flowId}/canvas`} className="goal-flow-link">
            {goal.flowName}
          </Link>
        ) : (
          <span className="goal-flow-missing">{t('未绑定流程')}</span>
        )}
        {goal.directoryName ? <span className="goal-dir">{goal.directoryName}</span> : null}
        {goal.lastRunId && goal.lastRunStatus ? (
          <Link
            href={goal.flowId ? `/workflows/${goal.flowId}/canvas?run=${goal.lastRunId}` : '/goals'}
            className="goal-run-link"
          >
            {t('本轮')} · {runStatusLabel(goal.lastRunStatus ?? '')}
          </Link>
        ) : null}
      </div>

      {goal.lastEval ? (
        <div className={`goal-eval${goal.lastEvalPassed ? ' passed' : ''}`}>
          <span className="goal-eval-title">{goal.lastEvalPassed ? t('✓ 验收通过') : t('上轮评估差距')}</span>
          <p>{goal.lastEval}</p>
        </div>
      ) : null}

      <button type="button" className="goal-expand" onClick={() => setExpanded((v) => !v)}>
        {expanded ? t('收起轮次谱系') : t('展开轮次谱系')}
      </button>
      {expanded ? (
        runsError ? (
          <div className="goal-runs-error">{runsError}</div>
        ) : runs == null ? (
          <div className="goal-runs-loading">{t('加载中…')}</div>
        ) : runs.length === 0 ? (
          <div className="goal-runs-empty">{t('还没有轮次——点「推一轮」开始第一轮')}</div>
        ) : (
          <div className="goal-runs">
            {runs.map((r) => (
              <Link
                key={r.runId}
                href={goal.flowId ? `/workflows/${goal.flowId}/canvas?run=${r.runId}` : '/goals'}
                className={`goal-run-row ${r.status}`}
              >
                <span className="goal-run-status">{runStatusLabel(r.status)}</span>
                <div className="goal-run-dur-track" title={durationLabel(r.durationMs)}>
                  <div
                    className={`goal-run-dur ${r.status === 'failed' ? 'failed' : ''}`}
                    style={{ width: `${Math.max(3, Math.round(((r.durationMs ?? 0) / maxDur) * 100))}%` }}
                  />
                </div>
                <span className="goal-run-dur-label">{durationLabel(r.durationMs)}</span>
              </Link>
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

// ─── 创建对话框 ───────────────────────────────────────────────────────

function CreateGoalDialog({
  open,
  flows,
  directories,
  onClose,
  onCreated,
}: {
  open: boolean
  flows: FlowOption[]
  directories: Directory[]
  onClose: () => void
  onCreated: () => void
}): React.ReactElement | null {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [flowId, setFlowId] = useState('')
  const [directoryId, setDirectoryId] = useState('')
  const [budget, setBudget] = useState('')
  const [auto, setAuto] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Esc 关闭（对话框可达性基线；提交中不误关）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, submitting, onClose])

  if (!open) return null

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      setError(t('目标不能为空'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await createGoal({
        title: title.trim(),
        description: description.trim() || undefined,
        acceptance: acceptance.trim() || undefined,
        flowId: flowId || undefined,
        directoryId: directoryId || undefined,
        budgetUsd: budget.trim() ? Number(budget) : null,
        auto,
      })
      onCreated()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="goal-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="goal-dialog" role="dialog" aria-modal="true" aria-labelledby="goal-dialog-title">
        <h2 className="goal-dialog-title" id="goal-dialog-title">
          {t('新建目标')}
        </h2>
        <label className="goal-field">
          <span>{t('目标')}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('例如：把旧官网重构为落地页优先的新站')}
            autoFocus
          />
        </label>
        <label className="goal-field">
          <span>{t('背景与要求')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder={t('给团队交代这个目标的来龙去脉与约束（可选）')}
          />
        </label>
        <label className="goal-field">
          <span>{t('验收标准')}</span>
          <textarea
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            rows={3}
            placeholder={t('逐条列出「做到什么才算达成」——评估员每轮按此打分，不放宽')}
          />
        </label>
        <div className="goal-field-row">
          <label className="goal-field">
            <span>{t('绑定流程')}</span>
            <select value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">{t('稍后绑定')}</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="goal-field">
            <span>{t('项目目录')}</span>
            <select value={directoryId} onChange={(e) => setDirectoryId(e.target.value)}>
              <option value="">{t('不绑定')}</option>
              {directories.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="goal-field-row">
          <label className="goal-field">
            <span>{t('预算上限（美元）')}</span>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              placeholder={t('留空 = 不设预算')}
            />
          </label>
          <label className="goal-field goal-auto">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>{t('自动推进（评估通过才停；预算/轮次护栏照常生效）')}</span>
          </label>
        </div>
        {error ? <div className="goal-dialog-error">{error}</div> : null}
        <div className="goal-dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('取消')}
          </button>
          <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? t('创建中…') : t('创建目标')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 主视图 ───────────────────────────────────────────────────────────

export function GoalsView(): React.ReactElement {
  const { t } = useI18n()
  const [goals, setGoals] = useState<Goal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [flows, setFlows] = useState<FlowOption[]>([])
  const [directories, setDirectories] = useState<Directory[]>([])

  useEffect(() => {
    void fetchDirectories().then(setDirectories).catch(() => {})
    void fetch('/api/workflows', { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json()) as { data?: { flows?: Array<{ id: string; name: string }> } }
        setFlows(body.data?.flows ?? [])
      })
      .catch(() => {})
  }, [dialogOpen])

  const reload = useCallback(async (): Promise<boolean> => {
    try {
      setGoals(await fetchGoals())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    return true
  }, [])

  // 5s 轮询（auto 目标在后台推进，看板要自己动起来）
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      if (stopped || document.hidden) return
      await reload()
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    const onVis = (): void => {
      if (document.visibilityState === 'visible' && timer == null) void tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [reload])

  const withBusy = async (id: string, fn: () => Promise<void>, okToast?: string): Promise<void> => {
    setBusyId(id)
    try {
      await fn()
      if (okToast) setToast(okToast)
      await reload()
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  useEffect(() => {
    if (!toast) return
    const h = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(h)
  }, [toast])

  const active = (goals ?? []).filter((g) => g.status !== 'achieved' && g.status !== 'archived')
  const done = (goals ?? []).filter((g) => g.status === 'achieved')

  return (
    <div className="goals-view">
      <header className="goals-header">
        <div>
          <h1 className="goals-title">{t('目标看板')}</h1>
          <p className="goals-subtitle">
            {t('给「同一目标」一个实体——团队按轮次推进，验收通过或预算耗尽才停')}
          </p>
        </div>
        <div className="goals-header-actions">
          <Link href="/team" className="goals-team-link">
            {t('公司作战室')}
          </Link>
          <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
            {t('新建目标')}
          </button>
        </div>
      </header>

      {error ? <div className="goals-error">{error}</div> : null}
      {toast ? <div className="goals-toast">{toast}</div> : null}

      {goals == null ? (
        <SkeletonList rows={3} shape="flow-card" />
      ) : active.length === 0 && done.length === 0 ? (
        <div className="goals-empty">
          <p>{t('还没有目标')}</p>
          <p className="goals-empty-hint">
            {t('写下一个目标 + 验收标准，绑定一条流程——你的虚拟团队就会围绕它一轮轮推进')}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
            {t('创建第一个目标')}
          </button>
        </div>
      ) : (
        <>
          <section className="goals-section">
            <h2 className="goals-section-title">
              {t('进行中')} · {active.length}
            </h2>
            <div className="goals-cards">
              {active.map((g) => (
                <GoalCard
                  key={g.id}
                  goal={g}
                  busy={busyId === g.id}
                  onAdvance={(goal) =>
                    void withBusy(goal.id, async () => {
                      const runId = await advanceGoal(goal.id)
                      setToast(t('第 {n} 轮已启动', { n: goal.round + 1 }) + ` · ${runId.slice(0, 8)}`)
                    })
                  }
                  onToggleAuto={(goal) =>
                    void withBusy(goal.id, () => patchGoal(goal.id, { auto: !goal.auto }).then(() => undefined))
                  }
                  onPatchStatus={(goal, status) =>
                    void withBusy(goal.id, () => patchGoal(goal.id, { status }).then(() => undefined))
                  }
                  onDelete={(goal) => {
                    if (window.confirm(t('删除目标「{title}」？轮次 run 记录保留。', { title: goal.title }))) {
                      void withBusy(goal.id, () => deleteGoal(goal.id).then(() => undefined))
                    }
                  }}
                />
              ))}
            </div>
          </section>
          {done.length > 0 ? (
            <section className="goals-section">
              <h2 className="goals-section-title">
                {t('已达成')} · {done.length}
              </h2>
              <div className="goals-cards done">
                {done.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    busy={busyId === g.id}
                    onAdvance={() => undefined}
                    onToggleAuto={() => undefined}
                    onPatchStatus={(goal, status) =>
                      void withBusy(goal.id, () => patchGoal(goal.id, { status }).then(() => undefined))
                    }
                    onDelete={(goal) => {
                      if (window.confirm(t('删除目标「{title}」？', { title: goal.title }))) {
                        void withBusy(goal.id, () => deleteGoal(goal.id).then(() => undefined))
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <CreateGoalDialog
        open={dialogOpen}
        flows={flows}
        directories={directories}
        onClose={() => setDialogOpen(false)}
        onCreated={() => void reload()}
      />
    </div>
  )
}
