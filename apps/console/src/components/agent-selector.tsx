'use client'

/**
 * Agent selector dropdown for the chat composer.
 *
 * Renders a pill button + popover list combining:
 *   1. DB agents (from agent_daemons via fetchAgents)
 *   2. Installed CLI runtimes not yet created as agents (from /api/cli-runtimes)
 *
 * When the user selects an installed-but-not-created CLI, it auto-creates the
 * agent via POST /api/agents and binds it to the chat — zero terminal steps.
 * Uninstalled CLIs are listed but greyed out (like open-design's AgentPicker).
 *
 * Keyboard a11y (WAI-ARIA listbox pattern):
 *   ArrowDown/Up: move through options (wraps). Enter: select. Escape: close.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { fetchAgents, AGENT_KINDS } from '@/lib/agents-catalog'
import { useToast } from '@/components/toast'
import { useSelectorDropdown } from '@/components/use-selector-dropdown'
import { useI18n } from '@/i18n'
import '@/styles/selector.css'
import '@/styles/agent-selector.css'

export interface AgentOption {
  id: string
  name: string
  /** Agent kind — powers exact CLI dedup (name-matching missed renamed
   * agents and offered duplicate creates). */
  kind: string
}

/** A CLI runtime detected on the host machine. */
interface CliRuntime {
  kind: string
  binary: string
  available: boolean
  path: string | null
}

interface AgentSelectorProps {
  /** Currently selected agent id (null = auto). */
  value: string | null
  /** Called when user picks an agent. */
  onChange: (agentId: string | null) => void
  /** Optional: disable the selector. */
  disabled?: boolean
}

export function AgentSelector({ value, onChange, disabled }: AgentSelectorProps): React.ReactElement {
  const { t } = useI18n()
  const toast = useToast()
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [loaded, setLoaded] = useState(false)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  /** CLI runtimes detected by the gateway (always fetched, regardless of agents.length). */
  const [runtimes, setRuntimes] = useState<CliRuntime[]>([])
  const [creating, setCreating] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  // Fetch DB agents
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { agents: rows } = await fetchAgents()
        if (!cancelled) {
          setAgents(rows.map((a) => ({ id: a.id, name: a.name, kind: a.kind })))
        }
      } catch (err) {
        // The dropdown must not silently pretend the user has no agents.
        if (!cancelled) setAgentsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Always fetch CLI runtimes so we can show installed-but-not-created CLIs
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const resp = await fetch('/api/cli-runtimes')
        const json = await resp.json()
        if (!cancelled && json.success) {
          setRuntimes(json.data.runtimes as CliRuntime[])
        }
      } catch {
        // silent — runtimes stay []
      }
    })()
    return () => { cancelled = true }
  }, [])

  /** Set of agent kinds already created in the DB — exact dedup against the
   *  CLI list (previously name-guessed, so a renamed `claude-code` agent
   *  still offered a duplicate create). */
  const dbKinds = new Set(agents.map((a) => a.kind))

  /** All installed CLIs (available=true), for display in the dropdown. */
  const installedCLIs = runtimes.filter((r) => r.available)

  // Quick-create an agent from an installed CLI, then select it
  async function quickCreateAgent(kind: string, label: string, binary: string): Promise<void> {
    setCreating(kind)
    setCreateError(null)
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `${label} 助手`,
          kind,
          executable_path: binary,
          executablePath: binary,
          summary: `${label} CLI agent`,
          visibility: 'workspace',
        }),
      })
      const json = (await resp.json()) as {
        success?: boolean
        data?: { id?: string }
        error?: string
        detail?: string
      }
      // 200 + { success: false } 也是失败 — 任一失败信号都要抛错
      if (!resp.ok || json.success === false || !json.data?.id) {
        throw new Error(json.error ?? json.detail ?? `HTTP ${resp.status}`)
      }
      // Refresh agent list, then select the created agent by its real id
      // (POST /api/agents returns { success, data: { id } }).
      const { agents: rows } = await fetchAgents()
      setAgents(rows.map((a) => ({ id: a.id, name: a.name, kind: a.kind })))
      onChange(json.data.id)
      toast.success(t('已创建 Agent「{name}」', { name: `${label} 助手` }))
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(null)
    }
  }

  const selected = agents.find((a) => a.id === value)
  const label = value ? (selected?.name ?? value.slice(0, 8)) : 'auto'

  /**
   * Build the flat list of selectable options for keyboard navigation:
   *   [0] = auto
   *   [1..N] = DB agents
   *   [N+1..M] = installed CLIs (not yet created)
   *
   * Uninstalled CLIs are shown but NOT in the keyboard nav (greyed out = display only).
   */
  const installedNotInDb = installedCLIs.filter((r) => !dbKinds.has(r.kind))

  // Total keyboard-navigable options: 1 (auto) + agents.length + installedNotInDb.length
  const optionCount = 1 + agents.length + installedNotInDb.length

  // 共享行为基座（PX-GL08）：开合/外点/键盘 listbox 导航/聚焦。
  // selectIndex 为函数声明，提升可用。打开时高亮播种到当前选中项。
  const {
    open, setOpen, highlighted, setHighlighted,
    ref, triggerRef, listboxId, onKeyDown,
  } = useSelectorDropdown({
    optionCount,
    initialHighlight: value === null ? 0 : agents.findIndex((a) => a.id === value) + 1,
    onSelectIndex: selectIndex,
  })

  function selectIndex(idx: number): void {
    if (idx < 0 || idx >= optionCount) return
    if (idx === 0) {
      onChange(null)
      setOpen(false)
      return
    }
    const agentIdx = idx - 1
    if (agentIdx < agents.length) {
      onChange(agents[agentIdx].id)
      setOpen(false)
      return
    }
    // It's an installed CLI — lazy-create
    const cliIdx = agentIdx - agents.length
    const cli = installedNotInDb[cliIdx]
    if (cli) {
      const meta = AGENT_KINDS.find((k) => k.kind === cli.kind)
      const lbl = meta?.label ?? cli.kind
      void quickCreateAgent(cli.kind, lbl, cli.binary)
    }
  }

  const showEmptyCreate = loaded && agents.length === 0

  return (
    <div className="agent-selector" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-selector-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={t('选择 Agent')}
      >
        <Icon name="bot" style={{ width: 14, height: 14, color: 'var(--accent)' }} />
        <span>{label}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="agent-selector-dropdown"
          aria-activedescendant={highlighted >= 0 ? `${listboxId}-opt-${highlighted}` : undefined}
        >
          {/* Auto option */}
          <button
            id={`${listboxId}-opt-0`}
            type="button"
            role="option"
            aria-selected={value === null}
            className={`agent-selector-option${value === null ? ' selected' : ''}${highlighted === 0 ? ' highlighted' : ''}`}
            onClick={() => { onChange(null); setOpen(false) }}
            onMouseEnter={() => setHighlighted(0)}
          >
            <Icon name="bot" style={{ width: 14, height: 14 }} />
            <span>auto</span>
            <span className="agent-selector-option-hint">{t('让 chat 自动选择')}</span>
          </button>

          {/* DB agents */}
          {agents.map((a, i) => {
            const idx = i + 1
            return (
              <button
                key={a.id}
                id={`${listboxId}-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={value === a.id}
                className={`agent-selector-option${value === a.id ? ' selected' : ''}${highlighted === idx ? ' highlighted' : ''}`}
                onClick={() => { onChange(a.id); setOpen(false) }}
                onMouseEnter={() => setHighlighted(idx)}
              >
                <Icon name="bot" style={{ width: 14, height: 14 }} />
                <span>{a.name}</span>
              </button>
            )
          })}

          {/* Installed CLIs not yet created as agents */}
          {installedNotInDb.length > 0 && (
            <div className="agent-selector-section-label">
              <Icon name="terminal" style={{ width: 12, height: 12 }} />
              <span>{t('已安装的 CLI · 选中即自动创建')}</span>
            </div>
          )}
          {agentsError && (
            <div className="agent-selector-error" role="alert">
              <Icon name="alertTriangle" style={{ width: 12, height: 12 }} />
              <span>{t('Agent 列表加载失败：{error}', { error: agentsError })}</span>
            </div>
          )}
          {createError && (
            <div className="agent-selector-error" role="alert">
              <Icon name="alertTriangle" style={{ width: 12, height: 12 }} />
              <span>{createError}</span>
            </div>
          )}
          {installedNotInDb.map((cli, i) => {
            const idx = 1 + agents.length + i
            const meta = AGENT_KINDS.find((k) => k.kind === cli.kind)
            const lbl = meta?.label ?? cli.kind
            const glyph = meta?.glyph ?? cli.kind.slice(0, 2).toUpperCase()
            return (
              <button
                key={cli.kind}
                id={`${listboxId}-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={false}
                className={`agent-selector-option${highlighted === idx ? ' highlighted' : ''}`}
                onClick={() => void quickCreateAgent(cli.kind, lbl, cli.binary)}
                onMouseEnter={() => setHighlighted(idx)}
              >
                <span className="agent-selector-glyph">{glyph}</span>
                <span>{lbl}</span>
                <span className="agent-selector-option-hint">
                  {creating === cli.kind ? t('创建中…') : t('点击创建')}
                </span>
              </button>
            )
          })}

          {/* Uninstalled CLIs — greyed out, display only */}
          {runtimes.filter((r) => !r.available).length > 0 && (
            <div className="agent-selector-section-label">
              <Icon name="terminal" style={{ width: 12, height: 12 }} />
              <span>{t('未安装')}</span>
            </div>
          )}
          {runtimes.filter((r) => !r.available).map((cli) => {
            const meta = AGENT_KINDS.find((k) => k.kind === cli.kind)
            const lbl = meta?.label ?? cli.kind
            const glyph = meta?.glyph ?? cli.kind.slice(0, 2).toUpperCase()
            return (
              <div key={cli.kind} className="agent-selector-option unavailable">
                <span className="agent-selector-glyph dim">{glyph}</span>
                <span>{lbl}</span>
                <span className="agent-selector-option-hint">{t('未安装')}</span>
              </div>
            )
          })}

          {/* Fallback: no agents + no runtimes detected at all */}
          {showEmptyCreate && installedCLIs.length === 0 && (
            <Link
              href="/agents"
              className="agent-selector-create-link"
              onClick={() => setOpen(false)}
            >
              <Icon name="plus" style={{ width: 12, height: 12 }} />
              <span>{t('还没有 Agent · 去创建')}</span>
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
