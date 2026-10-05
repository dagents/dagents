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
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n'
import { formatDuration, timeAgo, timeTitle } from '@/lib/format'
import { terminalHrefForDir } from '@/lib/terminal-links'
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
  /** 运行的项目目录锚（2026-09-19 P0 数据链）：失败行「终端」入口用；
   *  旧运行 / 未带目录为 null → 入口不渲染（诚实优先，不回落主目录）。 */
  directoryId?: string | null
  createdAt: string
  /** 谱系（2026-10-04）：从哪个 run 断点续跑/应答回流（无 = 根运行）。 */
  resumedFromRunId?: string | null
}

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  running: '运行中',
  pending: '排队中',
  // 2026-10-04 引擎新终态：失败分支隔离 / token 预算停机
  partial_success: '部分成功',
  budget_exceeded: '预算停机',
  awaiting_input: '等待输入',
}

/** 节点类型画像（/api/workflows/:id/analytics 的 nodeTypes 行）。 */
interface NodeTypeStat {
  nodeType: string
  executions: number
  failures: number
  avgMs: number | null
  p95Ms: number | null
  tokens: number
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

export function FlowRunsPanel({
  flowId,
  refreshTick = 0,
  onRerun,
}: FlowRunsPanelProps): React.ReactElement {
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

  // ── 节点类型画像（2026-10-04 用量分析）：与运行历史同数据源（spans），
  //    拉一次静态聚合即可（刷新随 refreshTick）；无数据/失败静默收起。
  const [typeStats, setTypeStats] = useState<NodeTypeStat[] | null>(null)
  const [showInsights, setShowInsights] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}/analytics`, {
          cache: 'no-store',
        })
        const json = (await res.json()) as {
          success: boolean
          data?: { nodeTypes?: NodeTypeStat[] }
          error?: string
        }
        if (!cancelled && res.ok && json.success) {
          setTypeStats(json.data?.nodeTypes?.filter((s) => s.executions > 0) ?? [])
        }
      } catch {
        if (!cancelled) setTypeStats(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [flowId, refreshTick])

  if (loading && runs.length === 0) {
    return (
      <div className="flow-runs">
        <div className="flow-runs-empty">{t('加载中…')}</div>
      </div>
    )
  }

  const totalTokens = (typeStats ?? []).reduce((n, s) => n + s.tokens, 0)

  return (
    <div className="flow-runs" role="list" aria-label={t('运行记录')}>
      {typeStats && typeStats.length > 0 ? (
        <div className="flow-runs-insights">
          <button
            type="button"
            className="flow-runs-insights-toggle"
            onClick={() => setShowInsights((v) => !v)}
            aria-expanded={showInsights}
          >
            {showInsights ? '▾' : '▸'} {t('节点画像')}
            <span className="flow-runs-insights-summary tnum">
              {' '}
              · {typeStats.length} {t('类节点')} · {totalTokens.toLocaleString()} tokens
            </span>
          </button>
          {showInsights ? (
            <table className="flow-runs-insights-table">
              <thead>
                <tr>
                  <th>{t('节点类型')}</th>
                  <th className="tnum">{t('执行')}</th>
                  <th className="tnum">{t('失败率')}</th>
                  <th className="tnum">{t('平均')}</th>
                  <th className="tnum">P95</th>
                  <th className="tnum">{t('tokens')}</th>
                </tr>
              </thead>
              <tbody>
                {typeStats.map((s) => (
                  <tr key={s.nodeType}>
                    <td>{s.nodeType}</td>
                    <td className="tnum">{s.executions}</td>
                    <td className={`tnum${s.failures > 0 ? ' danger' : ''}`}>
                      {s.executions > 0 ? `${Math.round((s.failures / s.executions) * 100)}%` : '—'}
                    </td>
                    <td className="tnum">{s.avgMs != null ? formatDuration(s.avgMs) : '—'}</td>
                    <td className="tnum">{s.p95Ms != null ? formatDuration(s.p95Ms) : '—'}</td>
                    <td className="tnum">{s.tokens > 0 ? s.tokens.toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
      {runs.length === 0 ? (
        <div className="flow-runs-empty">{t('暂无运行记录 — 点「运行」或到画布中触发')}</div>
      ) : (
        runs.map((r) => {
          const active = r.status === 'running' || r.status === 'pending'
          const timeStr = r.startedAt ?? r.createdAt
          const preview = previewText(r.inputPreview)
          const isResume = !!r.resumedFromRunId
          return (
            <div
              key={r.runId}
              className={`flow-runs-item${r.status === 'failed' ? ' failed' : ''}${isResume ? ' resumed' : ''}`}
              role="listitem"
            >
              {/* PX-F08 列契约：状态点+词（88px）→ 触发源 chip → 相对时间 →
                  输入预览（截 40ch）→ 耗时（tabular-nums 右对齐）→ 动作簇
                  （重跑/旁观/终端，右对齐单行 —— 拆开渲染会挤出隐式第二行
                  撑高行高，2026-09-19 修复）。 */}
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
                {isResume ? (
                  <span
                    className="chip chip-outline flow-runs-lineage"
                    title={t('从断点续跑：{id}', { id: r.resumedFromRunId!.slice(0, 8) })}
                  >
                    ↩ {t('续跑')}
                  </span>
                ) : null}
                <span className="flow-runs-time" title={timeTitle(timeStr)}>
                  {timeAgo(timeStr, t)}
                </span>
                <span className="flow-runs-input" title={preview ?? undefined}>
                  {preview ? preview.slice(0, 40) : '—'}
                </span>
                <span className="flow-runs-duration tnum">
                  {r.durationMs != null ? formatDuration(r.durationMs) : active ? t('进行中') : '—'}
                </span>
                <span className="flow-runs-actions">
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
                  {/* 双锚点 P1：失败行 + 有目录锚 → 深链终端排查；无目录不渲染
                      （诚实优先，不回落主目录）。 */}
                  {r.status === 'failed' && r.directoryId ? (
                    <Link
                      href={terminalHrefForDir(r.directoryId)}
                      className="btn btn-ghost btn-sm flow-runs-watch"
                      title={t('在项目目录打开终端')}
                    >
                      {t('终端')}
                    </Link>
                  ) : null}
                </span>
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
