'use client'

/**
 * FlowRunsPanel —— 单个 Flow 的运行历史（嵌在列表卡片的展开区）。
 *
 * 2026-08-30 用户裁决：运行历史不再单独占导航位（/runs 页已删），历史
 * 回到 flow 自己的上下文里 —— 此前这里是永远「暂无运行记录」的静态
 * 提示行。数据源与原 /runs 页同一 BFF（/api/runs?flowId=…，gateway
 * GET /api/v1/runs），行元素压缩为卡片宽度的紧凑形态。
 *
 * 刷新契约：挂载拉一次 + `refreshTick` 变化重拉（父组件在发起运行后
 * bump）；存在 running 行时 3s 轻轮询 —— 卡片展开着就能看到运行收尾。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n'
import { formatDateTime, formatDuration } from '@/lib/format'
import '@/styles/flow-runs.css'

interface RunRow {
  runId: string
  flowId: string | null
  status: string
  source: 'chat' | 'canvas'
  startedAt: string | null
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

export interface FlowRunsPanelProps {
  flowId: string
  /** 父组件 bump 触发重拉（发起运行后新 run 立即可见）。 */
  refreshTick?: number
}

export function FlowRunsPanel({ flowId, refreshTick = 0 }: FlowRunsPanelProps): React.ReactElement {
  const { t } = useI18n()
  const [runs, setRuns] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<number>(0)

  const load = useCallback(async (): Promise<RunRow[]> => {
    try {
      const res = await fetch(`/api/runs?flowId=${encodeURIComponent(flowId)}&limit=20`, {
        cache: 'no-store',
      })
      const json = (await res.json()) as { success: boolean; data?: RunRow[]; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      const rows = json.data ?? []
      setRuns(rows)
      return rows
    } catch {
      // 静默 —— 展开区是增强，失败不阻塞卡片
      return []
    } finally {
      setLoading(false)
    }
  }, [flowId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const rows = await load()
      if (cancelled) return
      // 有 running 行 → 3s 轻轮询直到全部终态（挂载/refreshTick 重入都会
      // 重置；卸载清理）。终态即停，不空转。
      window.clearInterval(timerRef.current)
      if (rows.some((r) => r.status === 'running' || r.status === 'pending')) {
        timerRef.current = window.setInterval(() => void load(), 3000)
      }
    })()
    return () => {
      cancelled = true
      window.clearInterval(timerRef.current)
    }
  }, [load, refreshTick])

  if (loading && runs.length === 0) {
    return (
      <div className="flow-runs">
        <div className="flow-runs-empty">{t('加载中…')}</div>
      </div>
    )
  }

  return (
    <div className="flow-runs" role="list" aria-label={t('运行记录')}>
      {runs.length === 0 ? (
        <div className="flow-runs-empty">{t('暂无运行记录 — 点「运行」或到画布中触发')}</div>
      ) : (
        runs.map((r) => (
          <div
            key={r.runId}
            className={`flow-runs-row${r.status === 'failed' ? ' failed' : ''}`}
            role="listitem"
          >
            <span
              className={`status-dot ${r.status === 'running' || r.status === 'pending' ? 'dot-running' : r.status === 'failed' ? 'dot-error' : 'dot-done'}`}
              title={t(STATUS_LABEL[r.status] ?? r.status)}
            />
            <span className={`flow-runs-status st-${r.status}`}>
              {t(STATUS_LABEL[r.status] ?? r.status)}
            </span>
            <span className="chip chip-outline flow-runs-source">
              {r.source === 'chat' ? t('聊天') : t('画布')}
            </span>
            <span className="flow-runs-time">{formatDateTime(r.startedAt ?? r.createdAt)}</span>
            <span className="flow-runs-time">
              {r.durationMs != null ? formatDuration(r.durationMs) : r.status === 'running' ? t('进行中') : '—'}
            </span>
            <span
              className="flow-runs-input"
              title={typeof r.inputPreview === 'string' ? r.inputPreview : undefined}
            >
              {typeof r.inputPreview === 'string' && r.inputPreview.trim() ? r.inputPreview.slice(0, 30) : '—'}
            </span>
            {r.error ? (
              <span className="flow-runs-error" title={r.error}>
                {r.error.slice(0, 60)}
              </span>
            ) : null}
            <Link
              href={`/workflows/${r.flowId}/canvas?run=${r.runId}`}
              className="btn btn-ghost btn-sm flow-runs-watch"
            >
              {t('画布旁观')}
            </Link>
          </div>
        ))
      )}
    </div>
  )
}
