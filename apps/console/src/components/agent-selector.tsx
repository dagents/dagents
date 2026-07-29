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
 *
 * Keyboard a11y (WAI-ARIA listbox pattern):
 *   - Trigger: aria-haspopup="listbox" + aria-expanded; focus stays on trigger.
 *   - ArrowDown/Up: moves `aria-activedescendant` through options (wraps).
 *   - Home/End: jump to first/last option.
 *   - Enter: selects the highlighted option.
 *   - Escape: closes the dropdown without changing selection.
 *   - When the catalogue comes back empty, the dropdown surfaces a
 *     "去 /agents 创建" link so the user has an actionable next step
 *     instead of a dead-end list with only "auto".
 */

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
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
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  /** Highlighted option index in the dropdown. -1 = none highlighted.
   *  Index 0 is always "auto"; indices 1..N are the fetched agents.
   *  When the list is empty (loaded && agents.length === 0), the only
   *  selectable option is "auto" at index 0, followed by the create-link
   *  row which is not a selectable option (it navigates instead). */
  const [highlighted, setHighlighted] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()

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
      } finally {
        if (!cancelled) setLoaded(true)
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

  // When the dropdown opens, highlight the currently selected option so the
  // user's first ArrowDown/Enter lands on a familiar row. When it closes,
  // return focus to the trigger so the keyboard user doesn't get stranded.
  useEffect(() => {
    if (!open) {
      setHighlighted(-1)
      return
    }
    const selectedIndex = value === null ? 0 : agents.findIndex((a) => a.id === value) + 1
    setHighlighted(selectedIndex >= 0 ? selectedIndex : 0)
    // Move focus to the trigger so keydown events land on the combobox.
    // The trigger keeps DOM focus; arrow keys move aria-activedescendant.
    triggerRef.current?.focus()
  }, [open, value, agents])

  const selected = agents.find((a) => a.id === value)
  const label = value ? (selected?.name ?? value.slice(0, 8)) : 'auto'

  // Total selectable options: 1 (auto) + N (agents). The empty-state
  // create-link is NOT a selectable option — it's a navigation link.
  const optionCount = 1 + agents.length

  function selectIndex(idx: number): void {
    if (idx < 0 || idx >= optionCount) return
    if (idx === 0) {
      onChange(null)
    } else {
      onChange(agents[idx - 1].id)
    }
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
      // When closed, ArrowDown/Up/Enter opens the dropdown.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlighted((prev) => (prev + 1) % optionCount)
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlighted((prev) => (prev - 1 + optionCount) % optionCount)
        break
      case 'Home':
        e.preventDefault()
        setHighlighted(0)
        break
      case 'End':
        e.preventDefault()
        setHighlighted(optionCount - 1)
        break
      case 'Enter':
        e.preventDefault()
        selectIndex(highlighted)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        // Let Tab close the dropdown naturally (focus moves to next element).
        setOpen(false)
        break
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
        title="选择 Agent"
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
            <span className="agent-selector-option-hint">让 chat 自动选择</span>
          </button>
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
          {showEmptyCreate ? (
            <Link
              href="/agents"
              className="agent-selector-create-link"
              onClick={() => setOpen(false)}
            >
              <Icon name="plus" style={{ width: 12, height: 12 }} />
              <span>还没有 Agent · 去创建</span>
            </Link>
          ) : null}
        </div>
      )}
    </div>
  )
}
