'use client'

/**
 * Agent selector dropdown for the chat composer (Task 6).
 *
 * Renders a pill button + popover list of agents fetched from the catalogue.
 * "auto" (null) means "let the chat pick the agent".
 *
 * Uses the shared `fetchAgents()` from `@/lib/agents-catalog` rather than raw
 * `fetch('/api/agents')`: the dispatch envelope is
 * `{ success, data: { agents, truncated } }` (snake_case rows), and
 * `fetchAgents()` already unwraps + maps rows to `CatalogAgent` — reusing it
 * keeps the selector on the same wire as the Agents page and new-task picker.
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import { fetchAgents } from '@/lib/agents-catalog'
import '@/styles/agent-selector.css'

export interface AgentOption {
  id: string
  name: string
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
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { agents: rows } = await fetchAgents()
        if (!cancelled) {
          setAgents(rows.map((a) => ({ id: a.id, name: a.name })))
        }
      } catch {
        // silent — selector shows just "auto" on failure
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selected = agents.find((a) => a.id === value)
  const label = value ? (selected?.name ?? value.slice(0, 8)) : 'auto'

  return (
    <div className="agent-selector" ref={ref}>
      <button
        type="button"
        className="agent-selector-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="Select agent"
      >
        <Icon name="bot" style={{ width: 14, height: 14, color: 'var(--accent)' }} />
        <span>{label}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="agent-selector-dropdown">
          <button
            type="button"
            className={`agent-selector-option${value === null ? ' selected' : ''}`}
            onClick={() => { onChange(null); setOpen(false) }}
          >
            <Icon name="bot" style={{ width: 14, height: 14 }} />
            <span>auto</span>
            <span className="agent-selector-option-hint">让 chat 自动选择</span>
          </button>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`agent-selector-option${value === a.id ? ' selected' : ''}`}
              onClick={() => { onChange(a.id); setOpen(false) }}
            >
              <Icon name="bot" style={{ width: 14, height: 14 }} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
