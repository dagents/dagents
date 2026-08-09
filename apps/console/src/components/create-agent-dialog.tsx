'use client'

/**
 * Create Agent dialog (multica-inspired).
 *
 * Modal form for registering a new agent. Collects name / kind / workspace /
 * daemon / summary / visibility / executable_path, then POSTs /api/agents
 * (→ gateway POST /api/v1/agents). On success the parent reloads the list
 * and the dialog closes.
 *
 * The gateway POST requires `workspaceId` (uuid) and `ownerId`. `ownerId` is
 * pulled from the session (`useSession().user.sub`); `workspaceId` has no
 * app-wide context today, so it is collected via a text input.
 *
 * multica's full AgentCreationStudio (mode chooser → templates → AI builder)
 * is intentionally out of scope for the initial version — this is the simpler
 * CreateAgentDialog pattern (single modal, single form). The kind picker now
 * spans all 18 CLI agent types (grouped 主流 / 国产 / ACP / 特殊 / 其他).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import { useSession } from '@/lib/auth-client'
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
  const [daemons, setDaemons] = useState<DaemonOption[]>([])
  const [loadingDaemons, setLoadingDaemons] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Session — gateway POST requires ownerId (the current user's sub).
  const { user } = useSession()

  // Form state
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AgentKind>('prompt')
  const [workspaceId, setWorkspaceId] = useState('')
  const [daemonId, setDaemonId] = useState('')
  const [summary, setSummary] = useState('')
  const [visibility, setVisibility] = useState<'workspace' | 'public'>('workspace')
  const [executablePath, setExecutablePath] = useState('')

  // Track whether executable_path holds a value the user typed themselves vs.
  // a value we auto-filled from the selected kind's default binary. We only
  // auto-fill when the field is empty OR still holds our last auto-fill, so a
  // user-typed path (e.g. `/usr/local/bin/claude`) is never clobbered.
  const lastAutoFilled = useRef<string>('')

  // Fetch daemons when the dialog opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingDaemons(true)
    setError(null)
    void (async () => {
      try {
        const list = await fetchDaemons()
        if (cancelled) return
        setDaemons(list)
        if (list.length > 0 && !daemonId) setDaemonId(list[0]!.id)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingDaemons(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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
    setWorkspaceId('')
    setDaemonId('')
    setSummary('')
    setVisibility('workspace')
    setExecutablePath('')
    lastAutoFilled.current = ''
    setError(null)
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
  const workspaceValid = workspaceId.trim().length > 0
  const daemonValid = daemonId.length > 0
  const ownerId = user?.sub ?? ''
  const canSubmit = nameValid && workspaceValid && daemonValid && ownerId.length > 0 && !submitting && !loadingDaemons

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const id = await createAgent({
        name: name.trim(),
        kind,
        workspaceId: workspaceId.trim(),
        ownerId,
        daemonId,
        executablePath: executablePath.trim() || null,
        visibility,
        summary: summary.trim() || null,
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
      <div className="drawer-backdrop open" onClick={onClose} aria-hidden="true" />
      <div
        className="modal-dialog open"
        role="dialog"
        aria-modal="true"
        aria-label="新建 Agent"
      >
        <div className="modal-head">
          <h2 className="modal-title">新建 Agent</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            onClick={onClose}
            disabled={submitting}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          {loadingDaemons ? (
            <div className="modal-loading">加载 daemon 列表…</div>
          ) : daemons.length === 0 ? (
            <div className="modal-empty">
              暂无已注册的 daemon。请先注册一个 daemon，再创建 agent。
            </div>
          ) : (
            <>
              {/* Identity */}
              <div className="form-section">
                <div className="form-section-label">身份</div>
                <div className="field">
                  <label htmlFor="agent-name">名称 *</label>
                  <input
                    id="agent-name"
                    type="text"
                    className={`input${name.length === 0 ? '' : nameValid ? '' : ' invalid'}`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如 claude-code"
                    maxLength={128}
                    autoFocus
                  />
                </div>
                <div className="field">
                  <label htmlFor="agent-workspace">工作区 ID *</label>
                  <input
                    id="agent-workspace"
                    type="text"
                    className={`input${workspaceId.length === 0 ? '' : workspaceValid ? '' : ' invalid'}`}
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    placeholder="例如 00000000-0000-4000-8000-000000000000"
                  />
                </div>
                <div className="field">
                  <label htmlFor="agent-summary">描述</label>
                  <textarea
                    id="agent-summary"
                    className="textarea"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    placeholder="一句话说明这个 agent 做什么"
                    rows={2}
                    maxLength={2000}
                  />
                </div>
              </div>

              {/* Execution */}
              <div className="form-section">
                <div className="form-section-label">执行</div>
                <div className="field">
                  <label htmlFor="agent-kind">类型</label>
                  <div className="kind-options-grouped">
                    {groupedOptions.map((g) => (
                      <div key={g.group} className="kind-group">
                        <div className="kind-group-label">{g.group}</div>
                        <div className="kind-options">
                          {g.options.map((k) => (
                            <button
                              key={k.kind}
                              type="button"
                              className={`kind-option${kind === k.kind ? ' active' : ''}`}
                              onClick={() => selectKind(k.kind)}
                              title={k.hint}
                            >
                              {k.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="agent-daemon">Daemon *</label>
                  <select
                    id="agent-daemon"
                    className="select"
                    value={daemonId}
                    onChange={(e) => setDaemonId(e.target.value)}
                  >
                    {daemons.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}（{d.status}）
                      </option>
                    ))}
                  </select>
                </div>
                {kind !== 'prompt' ? (
                  <div className="field">
                    <label htmlFor="agent-exec">可执行路径</label>
                    <input
                      id="agent-exec"
                      type="text"
                      className="input"
                      value={executablePath}
                      onChange={(e) => setExecutablePath(e.target.value)}
                      placeholder="例如 claude"
                    />
                  </div>
                ) : null}
              </div>

              {/* Access */}
              <div className="form-section">
                <div className="form-section-label">访问</div>
                <div className="field">
                  <label>可见性</label>
                  <div className="kind-options">
                    {VISIBILITY_OPTIONS.map((v) => (
                      <button
                        key={v.value}
                        type="button"
                        className={`kind-option${visibility === v.value ? ' active' : ''}`}
                        onClick={() => setVisibility(v.value)}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {error ? <div className="modal-error">{error}</div> : null}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </>
  )
}
