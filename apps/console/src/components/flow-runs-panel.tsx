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
 * bump）；存在 running 行时 3s 轻轮询到终态 —— 卡片展开着就能看到运行
 * 收尾。轮询走 usePolling（2026-09-17 收敛）：延续判定基于每轮刚拉到的
 * 行（此前按挂载时的首拨行决定，全部到终态后仍无限空转）。
 */
import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n'
import { formatDuration, timeAgo, timeTitle } from '@/lib/format'
import { usePolling } from '@/lib/use-polling'
import '@/styles/flow-runs.css'

interface RunRow {
  runId: string
  flowId: string | null
  status: string
  source: 'chat' | 'canvas'
  startedAt: string | null
  durationMs: number | null
  inputPreview: string | { input?: string } | null
  /** 运行输入全文（2026-09-08 可操作终端：重跑预填数据源；旧行可能缺省）。 */
  input?: string | null
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

/** gateway inputPreview 可能是 JSONB 对象（{"input":"…"}）—— 解包成文本。 */
function previewText(p: RunRow['inputPreview']): string | null {
  if (typeof p === 'string') return p.trim() || null
  if (p && typeof p === 'object' && typeof p.input === 'string') return p.input.trim() || null
  return null
}

export interface FlowRunsPanelProps {
  flowId: string
  /** 父组件 bump 触发重拉（发起运行后新 run 立即可见）。 */
  refreshTick?: number
  /** 重跑（2026-09-08 可操作终端 §4.2，⬆ 等价物）：父组件打开预填的
   *  运行对话框 —— 预填来源 = 该行输入全文（可能为 null：旧行无输入）。 */
  onRerun?: (input: string | null) => void
}

export function FlowRunsPanel({ flowId, refreshTick = 0, onRerun }: FlowRunsPanelProps): React.ReactElement {
  const { t } = useI18n()
  const [runs, setRuns] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(true)

  /** 拉一次运行历史；返回「是否存在未终态行」（usePolling 的延续判定，
   *  基于本轮新数据）。 */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/runs?flowId=${encodeURIComponent(flowId)}&limit=20`, {
        cache: 'no-store',
      })
      const json = (await res.json()) as { success: boolean; data?: RunRow[]; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      const rows = json.data ?? []
      setRuns(rows)
      return rows.some((r) => r.status === 'running' || r.status === 'pending')
    } catch {
      // 静默 —— 展开区是增强，失败不阻塞卡片
      return false
    } finally {
      setLoading(false)
    }
  }, [flowId])

  // 挂载 / refreshTick bump 立即拉一轮；有活跃行才 3s 轮询，全部终态即停
  usePolling(load, { intervalMs: 3000, visibilityPause: true, restartKey: refreshTick })

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
        runs.map((r) => {
          const active = r.status === 'running' || r.status === 'pending'
          const timeStr = r.startedAt ?? r.createdAt
          const preview = previewText(r.inputPreview)
          return (
            <div
              key={r.runId}
              className={`flow-runs-item${r.status === 'failed' ? ' failed' : ''}`}
              role="listitem"
            >
              {/* PX-F08 列契约：状态点+词（88px）→ 触发源 chip → 相对时间 →
                  输入预览（截 40ch）→ 耗时（tabular-nums 右对齐）→ 旁观。 */}
              <div className="flow-runs-row">
                <span className={`flow-runs-status st-${r.status}`}>
                  <span
                    className={`flow-runs-dot d-${r.status}${active ? ' breathe' : ''}`}
                    aria-hidden="true"
                  />
                  {t(STATUS_LABEL[r.status] ?? r.status)}
                </span>
                <span className="chip chip-outline flow-runs-source">
                  {r.source === 'chat' ? t('聊天') : t('画布')}
                </span>
                <span className="flow-runs-time" title={timeTitle(timeStr)}>
                  {timeAgo(timeStr, t)}
                </span>
                <span className="flow-runs-input" title={preview ?? undefined}>
                  {preview ? preview.slice(0, 40) : '—'}
                </span>
                <span className="flow-runs-duration tnum">
                  {r.durationMs != null
                    ? formatDuration(r.durationMs)
                    : active
                      ? t('进行中')
                      : '—'}
                </span>
                {onRerun ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm flow-runs-watch"
                    title={t('以相同输入重跑（输入可再编辑）')}
                    onClick={() => onRerun(r.input ?? preview)}
                  >
                    {t('重跑')}
                  </button>
                ) : null}
                <Link
                  href={`/workflows/${r.flowId}/canvas?run=${r.runId}`}
                  className="btn btn-ghost btn-sm flow-runs-watch"
                >
                  {t('画布旁观')}
                </Link>
              </div>
              {/* 失败摘要：第二行，--text-xs danger */}
              {r.error ? (
                <div className="flow-runs-error" title={r.error}>
                  {r.error.slice(0, 120)}
                </div>
              ) : null}
            </div>
          )
        })
      )}
    </div>
  )
}

