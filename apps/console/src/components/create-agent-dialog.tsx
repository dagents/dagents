'use client'

/**
 * Create Agent dialog (multica-inspired).
 *
 * Modal form for registering a new agent_daemons row. Collects name / kind /
 * daemon / summary / visibility / executable_path, then POSTs /api/agents.
 * On success the parent reloads the list and the dialog closes.
 *
 * multica's full AgentCreationStudio (mode chooser → templates → AI builder)
 * is intentionally out of scope for the initial version — this is the simpler
 * CreateAgentDialog pattern (single modal, single form) which fits mil-agents'
 * smaller agent surface (4 kinds, no skills/MCP/integrations yet).
 */

import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import {
  type AgentKind,
  type DaemonOption,
  createAgent,
  fetchDaemons,
} from '@/lib/agents-catalog'

const KIND_OPTIONS: { value: AgentKind; label: string; hint: string }[] = [
  { value: 'prompt', label: '提示词', hint: '纯提示词 agent，无 CLI 调用' },
  { value: 'claude', label: 'Claude Code', hint: 'Claude Code CLI agent' },
  { value: 'codex', label: 'Codex', hint: 'Codex CLI agent' },
  { value: 'remote', label: 'Remote', hint: '远程 HTTP agent' },
]

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

  // Form state
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AgentKind>('prompt')
  const [daemonId, setDaemonId] = useState('')
  const [summary, setSummary] = useState('')
  const [visibility, setVisibility] = useState<'workspace' | 'public'>('workspace')
  const [executablePath, setExecutablePath] = useState('')

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
    setDaemonId('')
    setSummary('')
    setVisibility('workspace')
    setExecutablePath('')
    setError(null)
  }, [open])

  if (!open) return null

  const nameValid = name.trim().length > 0 && name.trim().length <= 128
  const daemonValid = daemonId.length > 0
  const canSubmit = nameValid && daemonValid && !submitting && !loadingDaemons

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const id = await createAgent({
        name: name.trim(),
        kind,
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
                  <div className="kind-options">
                    {KIND_OPTIONS.map((k) => (
                      <button
                        key={k.value}
                        type="button"
                        className={`kind-option${kind === k.value ? ' active' : ''}`}
                        onClick={() => setKind(k.value)}
                        title={k.hint}
                      >
                        {k.label}
                      </button>
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
