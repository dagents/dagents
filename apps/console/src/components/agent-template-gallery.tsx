'use client'

/**
 * AgentTemplateGallery — one-click "create from template" modal.
 *
 * Fetches the static agent-template catalogue on mount, renders a grid of
 * template cards grouped by category (filter tabs), and on card click opens a
 * confirm step that calls instantiateAgentTemplate → toast → redirect to the
 * new agent's detail page.
 *
 * Visual language mirrors the create-agent dialog (modal-dialog + backdrop) and
 * the flow-card grid (icon + title + description). Loading skeletons + an error
 * state with retry keep the UX honest while the catalogue loads.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import {
  type AgentTemplate,
  type AgentTemplateCategory,
  fetchAgentTemplates,
  instantiateAgentTemplate,
} from '@/lib/agent-templates'
import '@/styles/dialog.css'
import '@/styles/agent-templates.css'

type CategoryFilter = 'all' | AgentTemplateCategory

const CATEGORY_TABS: { key: CategoryFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'popular', label: '热门' },
  { key: 'coding', label: '编码' },
  { key: 'specialist', label: '专家' },
]

export interface AgentTemplateGalleryProps {
  open: boolean
  onClose: () => void
}

export function AgentTemplateGallery({
  open,
  onClose,
}: AgentTemplateGalleryProps): React.ReactElement | null {
  const router = useRouter()
  const toast = useToast()
  const { t } = useI18n()

  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [confirming, setConfirming] = useState<AgentTemplate | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await fetchAgentTemplates()
      setTemplates(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch on open
  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  // Reset transient state when the gallery closes
  useEffect(() => {
    if (open) return
    setCategory('all')
    setConfirming(null)
    setError(null)
  }, [open])

  // Escape to close (mirrors create-agent-dialog)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        if (confirming) setConfirming(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting, confirming])

  const visible = useMemo(
    () => (category === 'all' ? templates : templates.filter((t) => t.category === category)),
    [templates, category],
  )

  if (!open) return null

  const handleConfirm = async () => {
    if (!confirming) return
    setSubmitting(true)
    try {
      const { id } = await instantiateAgentTemplate(confirming.id)
      toast.success(t('已从模板创建「{name}」', { name: confirming.name }))
      onClose()
      router.push(`/agents/${id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose} aria-hidden="true" />
      <div
        className="modal-dialog open atg-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('从模板创建 Agent')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('从模板创建')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('关闭')}
            onClick={onClose}
            disabled={submitting}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          {confirming ? (
            <div className="atg-confirm">
              <div className="atg-confirm-icon" aria-hidden="true">
                {confirming.icon}
              </div>
              <div className="atg-confirm-body">
                <div className="atg-confirm-name">{confirming.name}</div>
                <div className="atg-confirm-desc">{confirming.description}</div>
                <dl className="atg-confirm-meta">
                  <div>
                    <dt>{t('类型')}</dt>
                    <dd>{confirming.kind}</dd>
                  </div>
                  <div>
                    <dt>{t('模型')}</dt>
                    <dd>{confirming.model || t('默认')}</dd>
                  </div>
                  <div>
                    <dt>{t('角色')}</dt>
                    <dd>{confirming.roles.join('、') || '—'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          ) : (
            <>
              {/* category filter tabs */}
              <div className="atg-tabs" role="tablist" aria-label={t('模板分类')}>
                {CATEGORY_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={category === tab.key}
                    className={`atg-tab${category === tab.key ? ' active' : ''}`}
                    onClick={() => setCategory(tab.key)}
                  >
                    {t(tab.label)}
                  </button>
                ))}
              </div>

              {/* body: loading / error / grid */}
              {loading ? (
                <div className="atg-grid">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="atg-card atg-skeleton">
                      <div className="atg-card-icon skeleton" />
                      <div className="atg-card-body">
                        <div className="skeleton-text" style={{ width: '60%' }} />
                        <div className="skeleton-text" style={{ width: '90%', height: '10px' }} />
                        <div className="skeleton-text" style={{ width: '75%', height: '10px' }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="atg-error">
                  <div>{t('加载模板失败：{error}', { error })}</div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void load()}
                  >
                    {t('重试')}
                  </button>
                </div>
              ) : visible.length === 0 ? (
                <div className="atg-empty">{t('该分类暂无模板。')}</div>
              ) : (
                <div className="atg-grid">
                  {visible.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="atg-card"
                      onClick={() => setConfirming(tpl)}
                      aria-label={t('从模板 {name} 创建', { name: tpl.name })}
                    >
                      <div className="atg-card-icon" aria-hidden="true">
                        {tpl.icon}
                      </div>
                      <div className="atg-card-body">
                        <div className="atg-card-name">{tpl.name}</div>
                        <div className="atg-card-desc">{tpl.description}</div>
                      </div>
                      <div className="atg-card-kind">{tpl.kind}</div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirming(null)}
                disabled={submitting}
              >
                {t('返回')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleConfirm()}
                disabled={submitting}
              >
                {submitting ? t('创建中…') : t('创建')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
            >
              {t('取消')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
