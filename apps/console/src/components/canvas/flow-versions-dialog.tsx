'use client'

/**
 * FlowVersionsDialog —— 画布「历史版本」面板（2026-10-04 版本化回滚）。
 *
 * 数据源 GET /api/workflows/:id/versions（保存结构变更时网关自动存档的
 * 被覆盖旧结构，最近 20 版）；回滚 POST /:id/versions/:versionId/restore
 * ——回滚前网关先把当前结构存档（回滚可撤销）。回滚成功后整页刷新
 * （initialFlow 是服务端取的，不刷新画布看到的还是旧结构）。
 */

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import { timeAgo, timeTitle } from '@/lib/format'
import './flow-versions.css'

interface VersionRow {
  id: string
  name: string
  created_at: string
  nodeCount: number
}

export function FlowVersionsDialog({
  open,
  onClose,
  flowId,
}: {
  open: boolean
  onClose: () => void
  flowId: string
}): React.ReactElement | null {
  const { t } = useI18n()
  const [versions, setVersions] = useState<VersionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setVersions(null)
    setError(null)
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}/versions`, {
        cache: 'no-store',
      })
      const json = (await res.json()) as {
        success: boolean
        data?: { versions?: VersionRow[] }
        error?: string
      }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      setVersions(json.data?.versions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [flowId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // Esc 关闭（画布其他面板同款键盘语义）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const restore = async (versionId: string): Promise<void> => {
    if (restoringId) return
    if (!window.confirm(t('回滚到此版本') + '？' + t('（当前结构会先自动存档，可再回滚回来）')))
      return
    setRestoringId(versionId)
    setNotice(null)
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(flowId)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST' },
      )
      const json = (await res.json()) as { success: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      setNotice(t('已回滚，画布即将刷新'))
      setTimeout(() => window.location.reload(), 800)
    } catch (err) {
      setNotice(t('回滚失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div className="flow-versions-panel" role="dialog" aria-label={t('历史版本')}>
      <div className="flow-versions-head">
        <span className="flow-versions-title">{t('历史版本')}</span>
        <button
          type="button"
          className="flow-versions-close"
          onClick={onClose}
          aria-label={t('关闭')}
        >
          ×
        </button>
      </div>
      {notice ? <div className="flow-versions-notice">{notice}</div> : null}
      {error ? (
        <div className="flow-versions-empty">
          {t('加载版本失败')}：{error}
        </div>
      ) : versions == null ? (
        <div className="flow-versions-empty">{t('加载中…')}</div>
      ) : versions.length === 0 ? (
        <div className="flow-versions-empty">{t('暂无历史版本（保存结构变更后自动存档）')}</div>
      ) : (
        <ul className="flow-versions-list">
          {versions.map((v) => (
            <li key={v.id} className="flow-versions-item">
              <span className="flow-versions-meta">
                <span className="flow-versions-time" title={timeTitle(v.created_at)}>
                  {timeAgo(v.created_at, t)}
                </span>
                <span className="flow-versions-nodes">{t('{n} 个节点', { n: v.nodeCount })}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={restoringId != null}
                onClick={() => void restore(v.id)}
              >
                {restoringId === v.id ? t('回滚中…') : t('回滚到此版本')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
