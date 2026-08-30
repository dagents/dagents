'use client'

/**
 * FlowTemplateGallery — /flows 页「从模板创建」三 tab 画廊（docs/flow-templates.md §5）。
 *
 * 内置模板（仓库自带）/ 虚拟团队（agent-library 的生成式场景，单人指挥多 Agent ——
 * instantiate 仍走原端点，此处只统一入口）/ 我的模板（画布另存抽取）。
 * 确认步展示成员解析状态：可解析 → 将绑定 Agent；不可解析 → 将降级为 LLM
 * 节点（模板零依赖可跑的核心 UX）。降级数量在创建 toast 中显式告知。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import {
  fetchTeamTemplates,
  instantiateTeamTemplate,
  type TeamTemplateSummary,
} from '@/lib/agent-library'
import {
  type FlowTemplateSummary,
  deleteFlowTemplate,
  fetchFlowTemplates,
  instantiateFlowTemplate,
} from '@/lib/flow-templates'
import '@/styles/dialog.css'
import '@/styles/agent-templates.css'
import '@/styles/agent-library.css'
import '@/styles/flow-templates.css'

type Tab = 'builtin' | 'teams' | 'user'

const TABS: { key: Tab; label: string }[] = [
  { key: 'builtin', label: '内置模板' },
  { key: 'teams', label: '虚拟团队' },
  { key: 'user', label: '我的模板' },
]

export interface FlowTemplateGalleryProps {
  open: boolean
  onClose: () => void
}

export function FlowTemplateGallery({
  open,
  onClose,
}: FlowTemplateGalleryProps): React.ReactElement | null {
  const router = useRouter()
  const toast = useToast()
  const { t } = useI18n()

  const [tab, setTab] = useState<Tab>('builtin')
  const [templates, setTemplates] = useState<FlowTemplateSummary[]>([])
  const [teamTemplates, setTeamTemplates] = useState<TeamTemplateSummary[] | null>(null)
  const [teamError, setTeamError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmTpl, setConfirmTpl] = useState<FlowTemplateSummary | null>(null)
  const [confirmTeam, setConfirmTeam] = useState<TeamTemplateSummary | null>(null)
  const [paramAnswers, setParamAnswers] = useState<Record<string, string>>({})
  // 新工作流命名（2026-08-30）：默认模板名，用户可改 —— 此前不能命名，
  // 重复创建只能撞名。网关两端点早已支持 flow_name，前端一直没传。
  const [flowName, setFlowName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  // Two-step delete confirmation — the armed template id awaiting a second click.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setTeamError(null)
    try {
      // Team templates fail INDEPENDENTLY — swallowing the error here used to
      // dress a gateway failure up as "暂无虚拟团队场景".
      const [all, teamsRes] = await Promise.all([
        fetchFlowTemplates(),
        fetchTeamTemplates().then(
          (list) => ({ list, err: null as string | null }),
          (err: unknown) => ({ list: [] as TeamTemplateSummary[], err: err instanceof Error ? err.message : String(err) }),
        ),
      ])
      setTemplates(all)
      setTeamTemplates(teamsRes.list)
      setTeamError(teamsRes.err)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  // 切换确认模板时清空参数答案，避免上一个模板的值带进下一个。
  useEffect(() => {
    setParamAnswers({})
  }, [confirmTpl])
  useEffect(() => {
    setFlowName(confirmTpl?.name ?? confirmTeam?.name ?? '')
  }, [confirmTpl, confirmTeam])

  useEffect(() => {
    if (open) return
    setTab('builtin')
    setConfirmTpl(null)
    setConfirmTeam(null)
    setError(null)
    setTeamError(null)
    setConfirmDeleteId(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        if (confirmTpl || confirmTeam) {
          setConfirmTpl(null)
          setConfirmTeam(null)
        } else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting, confirmTpl, confirmTeam])

  const visible = useMemo(
    () => (tab === 'builtin' ? templates.filter((x) => x.source === 'builtin') : tab === 'user' ? templates.filter((x) => x.source === 'user') : []),
    [templates, tab],
  )

  if (!open) return null

  const handleInstantiate = async () => {
    if (!confirmTpl) return
    setSubmitting(true)
    try {
      const result = await instantiateFlowTemplate(confirmTpl.id, {
        flowName: flowName.trim() || confirmTpl.name,
        answers: paramAnswers,
      })
      const degraded = result.members.filter((m) => m.degraded).length
      toast.success(
        degraded > 0
          ? t('工作流已创建；{n} 个节点未解析到人格，已降级为 LLM 节点', { n: degraded })
          : t('工作流「{name}」已创建', { name: confirmTpl.name }),
      )
      onClose()
      router.push(`/workflows/${result.flowId}/canvas`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleTeamInstantiate = async () => {
    if (!confirmTeam) return
    setSubmitting(true)
    try {
      const result = await instantiateTeamTemplate(confirmTeam.id, { flowName: flowName.trim() || confirmTeam.name })
      toast.success(t('已创建工作流「{name}」（{n} 个成员 Agent）', {
        name: confirmTeam.name,
        n: result.members.length,
      }))
      onClose()
      router.push(`/workflows/${result.flowId}/canvas`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (tpl: FlowTemplateSummary) => {
    setDeleting(tpl.id)
    try {
      await deleteFlowTemplate(tpl.id)
      toast.success(t('已删除模板「{name}」', { name: tpl.name }))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(null)
    }
  }

  const tplCard = (tpl: FlowTemplateSummary, deletable: boolean) => (
    <div key={tpl.id} className="ftpl-card-wrap">
      <button
        type="button"
        className="atg-card ftpl-card"
        onClick={() => setConfirmTpl(tpl)}
        aria-label={t('查看模板 {name}', { name: tpl.name })}
      >
        <div className="atg-card-icon" aria-hidden="true">{tpl.icon}</div>
        <div className="atg-card-body">
          <div className="atg-card-name">{tpl.name}</div>
          <div className="atg-card-desc">{tpl.description}</div>
          {tpl.agentRefs.length > 0 && (
            <div className="alib-team-members">
              {tpl.agentRefs.map((r) => (
                <span
                  key={r.nodeId}
                  className={`alib-member-chip${r.available || !r.personaName ? '' : ' missing'}`}
                >
                  {r.personaName ?? t('匿名节点')}
                  {r.available ? '' : ` · ${t('降级 LLM')}`}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="ftpl-card-meta">{tpl.nodeCount} {t('节点')}</span>
      </button>
      {deletable && (
        <button
          type="button"
          className={`btn btn-ghost btn-sm ftpl-delete${confirmDeleteId === tpl.id ? ' btn-danger' : ''}`}
          aria-label={t('删除模板 {name}', { name: tpl.name })}
          onClick={() => {
            // Two-step confirm — first click arms, second click deletes.
            if (confirmDeleteId !== tpl.id) {
              setConfirmDeleteId(tpl.id)
              return
            }
            setConfirmDeleteId(null)
            void handleDelete(tpl)
          }}
          onBlur={() => {
            if (confirmDeleteId === tpl.id) setConfirmDeleteId(null)
          }}
          disabled={deleting === tpl.id}
        >
          <Icon name="close" style={{ width: 12, height: 12 }} />
          {deleting === tpl.id ? t('删除中…') : confirmDeleteId === tpl.id ? t('确认删除？') : t('删除')}
        </button>
      )}
    </div>
  )

  const confirming = confirmTpl ?? confirmTeam

  return (
    <>
      <div
        className="drawer-backdrop open"
        onClick={submitting ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className="modal-dialog open alib-dialog ftpl-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('从模板创建工作流')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('从模板创建')}</h2>
          <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onClose} disabled={submitting}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          {confirmTpl ? (
            <div className="alib-team-confirm">
              <div className="alib-confirm-head">
                <span className="alib-confirm-emoji" aria-hidden="true">{confirmTpl.icon}</span>
                <div>
                  <div className="alib-confirm-name">{confirmTpl.name}</div>
                  <div className="alib-confirm-desc">{confirmTpl.description}</div>
                </div>
              </div>
              <label className="ftpl-name-row">
                <span className="ftpl-name-label">{t('新工作流名称')}</span>
                <input
                  className="input ftpl-name-input"
                  value={flowName}
                  maxLength={128}
                  placeholder={confirmTpl.name}
                  onChange={(e) => setFlowName(e.target.value)}
                />
              </label>
              {(confirmTpl.layers?.length ?? 0) > 1 && (
                <div className="ftpl-layers" aria-label={t('流程结构')}>
                  <div className="ftpl-layers-title">{t('流程结构')}</div>
                  {confirmTpl.layers!.map((layer, i) => (
                    <div key={i} className="ftpl-layer">
                      {i > 0 && <span className="ftpl-layer-arrow" aria-hidden="true">↓</span>}
                      <div className={`ftpl-layer-nodes${layer.length > 1 ? ' parallel' : ''}`}>
                        {layer.length > 1 && <span className="ftpl-parallel-tag">{t('并行')}</span>}
                        {layer.map((n) => (
                          <span key={n.id} className="ftpl-node-chip" title={n.persona ?? undefined}>
                            <span className="ftpl-node-kind">{n.kind}</span>
                            <span className="ftpl-node-label">{n.label}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="alib-team-shape-hint">
                {confirmTpl.agentRefs.length === 0
                  ? t('纯 LLM 模板，零依赖开箱即跑。')
                  : t('可解析的人格将绑定真实 Agent；未解析的节点自动降级为 LLM（任务指令照常执行）。')}
              </div>
              {(confirmTpl.paramNames?.length ?? 0) > 0 && (
                <div className="ft-params">
                  <div className="alib-team-shape-hint">{t('模板包含变量，创建时回填到提示词（留空则按缺省值）。')}</div>
                  {confirmTpl.paramNames!.map((name) => (
                    <label key={name} className="ft-param-row">
                      <span className="ft-param-name">{`{{${name}}}`}</span>
                      <input
                        className="ft-param-input"
                        value={paramAnswers[name] ?? ''}
                        placeholder={t('留空使用缺省值')}
                        onChange={(e) =>
                          setParamAnswers((prev) => ({ ...prev, [name]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
              {confirmTpl.agentRefs.length > 0 && (
                <div className="alib-team-member-list">
                  {confirmTpl.agentRefs.map((r) => (
                    <div key={r.nodeId} className="alib-team-member">
                      <span className="alib-member-emoji" aria-hidden="true">🤖</span>
                      <div className="alib-member-body">
                        <div className="alib-member-name">{r.personaName ?? t('匿名节点')}</div>
                        <div className="alib-member-label">
                          {r.division ? `${r.division} · ` : ''}{r.nodeId}
                        </div>
                      </div>
                      <span className={`alib-badge ${r.available ? 'alib-badge-up-to-date' : 'alib-badge-locally-modified'}`}>
                        {r.available ? t('将绑定 Agent') : t('将降级为 LLM')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : confirmTeam ? (
            <div className="alib-team-confirm">
              <div className="alib-confirm-head">
                <span className="alib-confirm-emoji" aria-hidden="true">{confirmTeam.icon}</span>
                <div>
                  <div className="alib-confirm-name">{confirmTeam.name}</div>
                  <div className="alib-confirm-desc">{confirmTeam.description}</div>
                </div>
              </div>
              <label className="ftpl-name-row">
                <span className="ftpl-name-label">{t('新工作流名称')}</span>
                <input
                  className="input ftpl-name-input"
                  value={flowName}
                  maxLength={128}
                  placeholder={confirmTeam.name}
                  onChange={(e) => setFlowName(e.target.value)}
                />
              </label>
              <div className="ftpl-layers" aria-label={t('流程结构')}>
                <div className="ftpl-layers-title">{t('流程结构')}</div>
                {confirmTeam.shape === 'fan-out' ? (
                  <>
                    <div className="ftpl-layer">
                      <div className="ftpl-layer-nodes">
                        <span className="ftpl-node-chip">
                          <span className="ftpl-node-kind">start</span>
                          <span className="ftpl-node-label">{t('任务输入')}</span>
                        </span>
                      </div>
                    </div>
                    <div className="ftpl-layer">
                      <span className="ftpl-layer-arrow" aria-hidden="true">↓</span>
                      <div className="ftpl-layer-nodes parallel">
                        <span className="ftpl-parallel-tag">{t('并行')}</span>
                        {confirmTeam.members.map((m) => (
                          <span key={m.persona} className="ftpl-node-chip">
                            <span className="ftpl-node-kind">agent</span>
                            <span className="ftpl-node-label">{m.label || m.persona}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="ftpl-layer">
                      <span className="ftpl-layer-arrow" aria-hidden="true">↓</span>
                      <div className="ftpl-layer-nodes">
                        <span className="ftpl-node-chip">
                          <span className="ftpl-node-kind">llm</span>
                          <span className="ftpl-node-label">{t('汇总输出')}</span>
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ftpl-layer">
                      <div className="ftpl-layer-nodes">
                        <span className="ftpl-node-chip">
                          <span className="ftpl-node-kind">start</span>
                          <span className="ftpl-node-label">{t('任务输入')}</span>
                        </span>
                      </div>
                    </div>
                    {confirmTeam.members.map((m) => (
                      <div key={m.persona} className="ftpl-layer">
                        <span className="ftpl-layer-arrow" aria-hidden="true">↓</span>
                        <div className="ftpl-layer-nodes">
                          <span className="ftpl-node-chip">
                            <span className="ftpl-node-kind">agent</span>
                            <span className="ftpl-node-label">{m.label || m.persona}</span>
                          </span>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
              <div className="alib-team-shape-hint">
                {confirmTeam.shape === 'fan-out'
                  ? t('成员并行执行，最终由 LLM 节点汇总。')
                  : t('成员按顺序执行，上游产出作为下游输入。')}
                {t('缺失的成员将自动启用为 claude Agent（slim 档）；已启用的直接复用。')}
              </div>
              <div className="alib-team-member-list">
                {confirmTeam.members.map((m) => (
                  <div key={m.persona} className="alib-team-member">
                    <span className="alib-member-emoji" aria-hidden="true">{m.emoji ?? '🤖'}</span>
                    <div className="alib-member-body">
                      <div className="alib-member-name">{m.persona}</div>
                      <div className="alib-member-label">{m.label}{m.division ? ` · ${m.division}` : ''}</div>
                    </div>
                    <span className={`alib-badge alib-badge-${m.available ? 'up-to-date' : 'diverged'}`}>
                      {m.available ? t('可解析') : t('库中缺失')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="alib-mode-tabs" role="tablist" aria-label={t('模板类型')}>
                {TABS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.key}
                    className={`alib-chip${tab === item.key ? ' active' : ''}`}
                    onClick={() => setTab(item.key)}
                  >
                    {t(item.label)}
                    {item.key === 'user' && templates.some((x) => x.source === 'user') && (
                      <span className="alib-chip-count">
                        {templates.filter((x) => x.source === 'user').length}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {loading ? (
                <div className="atg-grid">
                  {Array.from({ length: 4 }, (_, i) => (
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
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                    {t('重试')}
                  </button>
                </div>
              ) : tab === 'teams' ? (
                teamError ? (
                  <div className="atg-error">
                    <div>{t('加载团队场景失败：{error}', { error: teamError })}</div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                      {t('重试')}
                    </button>
                  </div>
                ) : (teamTemplates ?? []).length === 0 ? (
                  <div className="atg-empty">{t('暂无虚拟团队场景。')}</div>
                ) : (
                  <div className="atg-grid alib-team-grid">
                    {(teamTemplates ?? []).map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        className="atg-card alib-team-card"
                        onClick={() => setConfirmTeam(tpl)}
                        aria-label={t('查看虚拟团队场景 {name}', { name: tpl.name })}
                      >
                        <div className="atg-card-icon" aria-hidden="true">{tpl.icon}</div>
                        <div className="atg-card-body">
                          <div className="atg-card-name">{tpl.name}</div>
                          <div className="atg-card-desc">{tpl.description}</div>
                          <div className="alib-team-members">
                            {tpl.members.map((m) => (
                              <span key={m.persona} className={`alib-member-chip${m.available ? '' : ' missing'}`}>
                                {m.emoji ?? '🤖'} {m.label}
                                {!m.available && <em> {t('库中缺失')}</em>}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : visible.length === 0 ? (
                <div className="atg-empty">
                  {tab === 'user'
                    ? t('还没有自己的模板 —— 在画布页点「另存为模板」把跑通的流程固化下来。')
                    : t('暂无模板。')}
                </div>
              ) : (
                <div className="atg-grid">
                  {visible.map((tpl) => tplCard(tpl, tab === 'user'))}
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
                onClick={() => {
                  setConfirmTpl(null)
                  setConfirmTeam(null)
                }}
                disabled={submitting}
              >
                {t('返回')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() =>
                  confirmTeam ? void handleTeamInstantiate() : void handleInstantiate()
                }
                disabled={submitting}
              >
                {submitting ? t('创建中…') : t('创建工作流')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              {t('取消')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
