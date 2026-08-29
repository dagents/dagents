'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import { formatDateTime, formatDuration } from '@/lib/format'
import '@/styles/runs-view.css'

/**
 * /runs —— 跨 Flow 运行历史页（PRD F5，评审 D3：本期只读）。
 *
 * 列：状态点 / Flow 名（点击画布旁观）/ 触发源 / 起止 / 耗时 / 输入预览 /
 * 失败原因摘要（首个 failed 节点的 error，不点进去就能看到为什么红）。
 * 筛选：状态。数据源 console BFF /api/runs → gateway GET /api/v1/runs。
 */

type RunStatus = 'completed' | 'failed' | 'cancelled' | 'running'

interface RunRow {
  runId: string
  flowId: string | null
  flowName: string | null
  status: string
  source: 'chat' | 'canvas'
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  inputPreview: string | { input?: string } | null
  error: string | null
  createdAt: string
}

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  running: '运行中',
  pending: '排队中',
}

const STATUS_FILTERS: Array<'all' | RunStatus> = ['all', 'running', 'completed', 'failed', 'cancelled']

export default function RunsPage(): React.ReactElement {
  const { t } = useI18n()
  const [runs, setRuns] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | RunStatus>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`
      const res = await fetch(`/api/runs${qs}`, { cache: 'no-store' })
      const json = (await res.json()) as { success: boolean; data?: RunRow[]; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      setRuns(json.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <PageShell
      crumb={t('运行历史')}
      actions={
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          <Icon name="refresh" style={{ width: 12, height: 12 }} />
          {t('刷新')}
        </button>
      }
    >
      <div className="runs-toolbar" role="tablist" aria-label={t('状态筛选')}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={statusFilter === s}
            className={`runs-filter-chip${statusFilter === s ? ' active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === 'all' ? t('全部') : t(STATUS_LABEL[s] ?? s)}
          </button>
        ))}
      </div>

      {error ? (
        <div className="empty-state">
          <div className="h" style={{ color: 'var(--danger)' }}>{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            {t('重试')}
          </button>
        </div>
      ) : loading && runs.length === 0 ? (
        <div className="empty-state">{t('加载运行历史…')}</div>
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">📋</div>
          <div className="h">{t('还没有运行记录')}</div>
          <div className="d">{t('从工作流页或聊天触发一次运行，记录会出现在这里')}</div>
        </div>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th>{t('状态')}</th>
              <th>{t('工作流')}</th>
              <th>{t('触发源')}</th>
              <th>{t('开始时间')}</th>
              <th>{t('耗时')}</th>
              <th>{t('输入')}</th>
              <th>{t('失败原因')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId} className={r.status === 'failed' ? 'runs-row-failed' : undefined}>
                <td>
                  <span className={`status-dot ${r.status === 'running' ? 'dot-running' : r.status === 'failed' ? 'dot-error' : 'dot-done'}`} />
                  <span className="runs-status-label">{t(STATUS_LABEL[r.status] ?? r.status)}</span>
                </td>
                <td className="runs-flow-cell">
                  <span className="runs-flow-name">{r.flowName ?? t('（已删除的 Flow）')}</span>
                </td>
                <td>
                  <span className="chip chip-outline" style={{ fontSize: 10 }}>
                    {r.source === 'chat' ? t('聊天') : t('画布')}
                  </span>
                </td>
                <td className="runs-time-cell">{formatDateTime(r.startedAt ?? r.createdAt)}</td>
                <td className="runs-time-cell">{r.durationMs != null ? formatDuration(r.durationMs) : '—'}</td>
                <td className="runs-input-cell" title={typeof r.inputPreview === 'string' ? r.inputPreview : undefined}>
                  {typeof r.inputPreview === 'string' && r.inputPreview.trim()
                    ? r.inputPreview.slice(0, 40)
                    : '—'}
                </td>
                <td className="runs-error-cell" title={r.error ?? undefined}>
                  {r.error ?? '—'}
                </td>
                <td>
                  {r.flowId ? (
                    <Link
                      href={`/workflows/${r.flowId}/canvas?run=${r.runId}`}
                      className="btn btn-ghost btn-sm"
                    >
                      {t('画布旁观')}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageShell>
  )
}
