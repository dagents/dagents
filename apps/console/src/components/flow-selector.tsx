'use client'

/**
 * Flow selector dropdown for the chat composer.
 *
 * Renders a pill button + popover list of workflows fetched from
 * `/api/workflows`. "none" (null) means no flow is bound to the chat.
 *
 * Mirrors the AgentSelector's WAI-ARIA listbox pattern:
 *   - Trigger: aria-haspopup="listbox" + aria-expanded; focus stays on trigger.
 *   - ArrowDown/Up: moves aria-activedescendant through options (wraps).
 *   - Home/End: jump to first/last option.
 *   - Enter: selects the highlighted option.
 *   - Escape: closes the dropdown without changing selection.
 */

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/flow-selector.css'

export interface FlowOption {
  id: string
  name: string
}

interface FlowSelectorProps {
  /** Currently selected flow id (null = none). */
  value: string | null
  /** Called when user picks a flow. */
  onChange: (flowId: string | null) => void
  /** Optional: disable the selector. */
  disabled?: boolean
}

export function FlowSelector({ value, onChange, disabled }: FlowSelectorProps): React.ReactElement {
  const { t } = useI18n()
  const [flows, setFlows] = useState<FlowOption[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()

  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/workflows', { cache: 'no-store' })
      const json = (await res.json()) as {
        success: boolean
        data?: { flows?: { id: string; name: string }[] } | FlowOption[]
        error?: string
      }
      if (json.success && json.data) {
        const list = Array.isArray(json.data)
          ? json.data
          : json.data.flows ?? []
        setFlows(list.map((f) => ({ id: f.id, name: f.name })))
        setLoadError(null)
      } else {
        setLoadError(json.error ?? `HTTP ${res.status}`)
      }
    } catch (err) {
      // A failure must not masquerade as "还没有 Flow" — the user would
      // conclude their flows are gone.
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    void load()
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

  // Highlight tracks selection changes, but FOCUS only on open — a value
  // change while open (e.g. quick rebind) must not yank focus back.
  useEffect(() => {
    if (!open) {
      setHighlighted(-1)
      return
    }
    const selectedIndex = value === null ? 0 : flows.findIndex((f) => f.id === value) + 1
    setHighlighted(selectedIndex >= 0 ? selectedIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) triggerRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const selectedIndex = value === null ? 0 : flows.findIndex((f) => f.id === value) + 1
    setHighlighted(selectedIndex >= 0 ? selectedIndex : 0)
  }, [value, flows, open])

  const selected = flows.find((f) => f.id === value)
  const label = value ? (selected?.name ?? value.slice(0, 8)) : t('无 Flow')

  const optionCount = 1 + flows.length

  function selectIndex(idx: number): void {
    if (idx < 0 || idx >= optionCount) return
    if (idx === 0) {
      onChange(null)
    } else {
      onChange(flows[idx - 1].id)
    }
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
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
        setOpen(false)
        break
    }
  }

  const showEmptyCreate = loaded && flows.length === 0

  return (
    <div className="flow-selector" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="flow-selector-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={t('选择 Flow')}
      >
        <Icon name="flows" style={{ width: 14, height: 14, color: 'var(--accent)' }} />
        <span>{label}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('选择 Flow')}
          className="flow-selector-dropdown"
          aria-activedescendant={highlighted >= 0 ? `${listboxId}-opt-${highlighted}` : undefined}
        >
          <button
            id={`${listboxId}-opt-0`}
            type="button"
            role="option"
            aria-selected={value === null}
            className={`flow-selector-option${value === null ? ' selected' : ''}${highlighted === 0 ? ' highlighted' : ''}`}
            onClick={() => { onChange(null); setOpen(false) }}
            onMouseEnter={() => setHighlighted(0)}
          >
            <Icon name="flows" style={{ width: 14, height: 14 }} />
            <span>{t('无 Flow')}</span>
            <span className="flow-selector-option-hint">{t('不绑定工作流')}</span>
          </button>
          {flows.map((f, i) => {
            const idx = i + 1
            return (
              <button
                key={f.id}
                id={`${listboxId}-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={value === f.id}
                className={`flow-selector-option${value === f.id ? ' selected' : ''}${highlighted === idx ? ' highlighted' : ''}`}
                onClick={() => { onChange(f.id); setOpen(false) }}
                onMouseEnter={() => setHighlighted(idx)}
              >
                <Icon name="flows" style={{ width: 14, height: 14 }} />
                <span>{f.name}</span>
              </button>
            )
          })}
          {loadError ? (
            <div className="agent-selector-error" role="alert">
              <Icon name="alertTriangle" style={{ width: 12, height: 12 }} />
              <span>{t('Flow 列表加载失败：{error}', { error: loadError })}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
                {t('重试')}
              </button>
            </div>
          ) : null}
          {showEmptyCreate && !loadError ? (
            <Link
              href="/flows"
              className="flow-selector-create-link"
              onClick={() => setOpen(false)}
            >
              <Icon name="plus" style={{ width: 12, height: 12 }} />
              <span>{t('还没有 Flow · 去创建')}</span>
            </Link>
          ) : null}
        </div>
      )}
    </div>
  )
}
