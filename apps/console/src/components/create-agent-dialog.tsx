'use client'

/**
 * Create Agent dialog (multica-inspired).
 *
 * Modal form for registering a new agent. Collects name / kind / workspace /
 * execution target / summary / visibility / executable_path, then POSTs
 * /api/agents (→ gateway POST /api/v1/agents). On success the parent reloads
 * the list and the dialog closes.
 *
 * The gateway POST only truly requires `name` + `kind`. There is no login
 * (本机模式), so `ownerId` defaults to `'local'`; `workspaceId` is omitted —
 * the gateway assigns the Default workspace (…0001) automatically.
 *
 * multica's full AgentCreationStudio (mode chooser → templates → AI builder)
 * is intentionally out of scope for the initial version — this is the simpler
 * CreateAgentDialog pattern (single modal, single form). The kind picker now
 * spans all 18 CLI agent types (grouped 主流 / 国产 / ACP / 特殊 / 其他).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/dialog.css'
import {
  type AgentKind,
  type AgentKindGroup,
  type DaemonOption,
  AGENT_KINDS,
  createAgent,
  fetchDaemons,
  kindBinary,
} from '@/lib/agents-catalog'

/**
 * Kind picker options, derived from the shared {@link AGENT_KINDS} metadata so
 * the dialog, the agents list, and the settings runtimes table all agree on
 * label / hint / default binary / group. Grouped for visual grouping in the
 * picker (主流 / 国产 / ACP / 特殊 / 其他).
 */
const KIND_OPTIONS = AGENT_KINDS

/** Ordered groups rendered as sub-headings in the kind picker. */
const KIND_GROUPS: AgentKindGroup[] = ['主流', '国产', 'ACP', '特殊', '其他']

const VISIBILITY_OPTIONS: { value: 'workspace' | 'public'; label: string }[] = [
  { value: 'workspace', label: '工作区' },
  { value: 'public', label: '公开' },
]

export interface CreateAgentDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}

export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: CreateAgentDialogProps): React.ReactElement | null {
  const { t } = useI18n()
  const [daemons, setDaemons] = useState<DaemonOption[]>([])
  const [loadingDaemons, setLoadingDaemons] = useState(false)
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AgentKind>('prompt')
  const [daemonId, setDaemonId] = useState('')
  const [summary, setSummary] = useState('')
  const [visibility, setVisibility] = useState<'workspace' | 'public'>('workspace')
  const [executablePath, setExecutablePath] = useState('')

  // Track whether executable_path holds a value the user typed themselves vs.
  // a value we auto-filled from the selected kind's default binary. We only
  // auto-fill when the field is empty OR still holds our last auto-fill, so a
  // user-typed path (e.g. `/usr/local/bin/claude`) is never clobbered.
  const lastAutoFilled = useRef<string>('')

  const loadDaemons = useCallback(async (): Promise<void> => {
    setLoadingDaemons(true)
    setDaemonError(null)
    try {
      setDaemons(await fetchDaemons())
    } catch (err) {
      // Daemon 列表加载失败不阻塞创建 — 默认"本机"不依赖它，但要如实说。
      setDaemonError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingDaemons(false)
    }
  }, [])

  // Fetch daemons when the dialog opens
  useEffect(() => {
    if (!open) return
    void loadDaemons()
  }, [open, loadDaemons])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting])

  // Reset form when closed
  useEffect(() => {
    if (open) return
    setName('')
    setKind('prompt')
    setDaemonId('')
    setSummary('')
    setVisibility('workspace')
    setExecutablePath('')
    lastAutoFilled.current = ''
    setError(null)
    setDaemonError(null)
  }, [open])

  /** Kind-picker options bucketed by group, preserving KIND_GROUPS order.
   *  Empty groups are skipped so the picker has no orphan headings. */
  const groupedOptions = useMemo(
    () =>
      KIND_GROUPS.map((g) => ({
        group: g,
        options: KIND_OPTIONS.filter((o) => o.group === g),
      })).filter((g) => g.options.length > 0),
    [],
  )

  /** Select a kind and, if the executable_path field is empty or still holds
   *  our previous auto-fill, pre-fill it with the kind's default binary. A
   *  user-typed path is preserved (never overwritten). */
  function selectKind(next: AgentKind): void {
    setKind(next)
    const binary = kindBinary(next)
    if (!binary) return // non-CLI kinds (prompt/remote) have no default binary
    if (executablePath === '' || executablePath === lastAutoFilled.current) {
      setExecutablePath(binary)
      lastAutoFilled.current = binary
    }
  }

  if (!open) return null

  const nameValid = name.trim().length > 0 && name.trim().length <= 128
  // 本机模式无登录：owner 固定 'local'（与 gateway POST 默认值一致）。
  const ownerId = 'local'
  // daemon 可选：默认"本机"走 inline 执行（gateway 直接 spawn CLI），只有绑定
  // 远程 daemon 时才选具体条目（gateway 端 daemonId 本就是 optional）。
  // workspace 同理不收集 — gateway 端默认 Default 工作区（...0001）。
  // 创建不依赖 daemon 列表（哪怕它加载失败/为空）——本机 inline 是合法路径。
  const canSubmit = nameValid && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const id = await createAgent({
        name: name.trim(),
        kind,
        ownerId,
        daemonId: daemonId || undefined,
        executablePath: executablePath.trim() || null,
        visibility,
        summary: summary.trim() || undefined,
      })
      onCreated(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="drawer-backdrop open"
        onClick={submitting ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className="modal-dialog open"
        role="dialog"
        aria-modal="true"
        aria-label={t('新建 Agent')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('新建 Agent')}</h2>
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
          {/* The form is ALWAYS rendered — daemon 可选（本机 inline 执行是
              合法路径），daemon 列表为空或加载失败都只在执行区提示。 */}
          <>
            {/* Identity */}
            <div className="form-section">
              <div className="form-section-label">{t('身份')}</div>
              <div className="field">
                <label htmlFor="agent-name">{t('名称 *')}</label>
                <input
                  id="agent-name"
                  type="text"
                  className={`input${name.length === 0 ? '' : nameValid ? '' : ' invalid'}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('例如 claude-code')}
                  maxLength={128}
                  autoFocus
                  aria-invalid={name.length > 0 && !nameValid}
                  aria-describedby={name.length > 0 && !nameValid ? 'agent-name-error' : undefined}
                />
                {name.length > 0 && !nameValid ? (
                  <div id="agent-name-error" className="field-error" role="alert">
                    {t('名称需 1–128 个字符')}
                  </div>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="agent-summary">{t('描述')}</label>
                <textarea
                  id="agent-summary"
                  className="textarea"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder={t('一句话说明这个 agent 做什么')}
                  rows={2}
                  maxLength={2000}
                />
              </div>
            </div>

            {/* Execution */}
            <div className="form-section">
              <div className="form-section-label">{t('执行')}</div>
              <div className="field">
                <label htmlFor="agent-kind">{t('类型')}</label>
                <div className="kind-options-grouped">
                  {groupedOptions.map((g) => (
                    <div key={g.group} className="kind-group">
                      <div className="kind-group-label">{t(g.group)}</div>
                      <div className="kind-options">
                        {g.options.map((k) => (
                          <button
                            key={k.kind}
                            type="button"
                            className={`kind-option${kind === k.kind ? ' active' : ''}`}
                            onClick={() => selectKind(k.kind)}
                            title={t(k.hint)}
                          >
                            {t(k.label)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="agent-daemon">{t('执行位置')}</label>
                <select
                  id="agent-daemon"
                  className="select"
                  value={daemonId}
                  onChange={(e) => setDaemonId(e.target.value)}
                >
                  <option value="">{t('本机（inline 直接执行，无需 daemon）')}</option>
                  {daemons.map((d) => (
                    <option key={d.id} value={d.id}>
                      {t('Daemon · {label}（{status}）', { label: d.label, status: d.status })}
                    </option>
                  ))}
                </select>
                {daemonError ? (
                  <div className="field-hint" style={{ color: 'var(--warn, #b45309)' }}>
                    {t('Daemon 列表加载失败：{error}', { error: daemonError })}{' '}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadDaemons()}>
                      {t('重试')}
                    </button>
                    {t(' · 仍可创建（默认本机执行）')}
                  </div>
                ) : !loadingDaemons && daemons.length === 0 ? (
                  <div className="field-hint">
                    {t('未检测到已注册的 daemon — Agent 将在本机 inline 执行。')}
                  </div>
                ) : null}
              </div>
              {kind !== 'prompt' ? (
                <div className="field">
                  <label htmlFor="agent-exec">{t('可执行路径')}</label>
                  <input
                    id="agent-exec"
                    type="text"
                    className="input"
                    value={executablePath}
                    onChange={(e) => setExecutablePath(e.target.value)}
                    placeholder={t('例如 claude')}
                  />
                </div>
              ) : null}
            </div>

            {/* Access */}
            <div className="form-section">
              <div className="form-section-label">{t('访问')}</div>
              <div className="field">
                <label>{t('可见性')}</label>
                <div className="kind-options">
                  {VISIBILITY_OPTIONS.map((v) => (
                    <button
                      key={v.value}
                      type="button"
                      className={`kind-option${visibility === v.value ? ' active' : ''}`}
                      onClick={() => setVisibility(v.value)}
                    >
                      {t(v.label)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {error ? <div className="modal-error">{error}</div> : null}
          </>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={submitting}
          >
            {t('取消')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting ? t('创建中…') : t('创建')}
          </button>
        </div>
      </div>
    </>
  )
}
