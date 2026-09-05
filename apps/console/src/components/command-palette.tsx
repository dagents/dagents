'use client'

/**
 * CommandPalette — global Cmd+K quick-navigation & actions.
 *
 * Design intent: a Linear/Raycast-style command menu that lets the user
 * jump to any page, create new resources, or search recent chats without
 * touching the mouse. Mounted once at the ChatLayout root; opens via
 * Cmd/Ctrl+K or by clicking the navbar search affordance.
 *
 * Commands are sourced from NAV (pages) + a small static action set
 * (新建…) + live chat search via /api/chats. Filtering is fuzzy
 * case-insensitive substring match on label + keywords; arrow keys move
 * the selection, Enter runs the highlighted item, Esc closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { NAV } from '@/components/nav'
import { useI18n } from '@/i18n'
import '@/styles/command-palette.css'
// .kbd（统一 kbd 键帽，shortcuts.css 单一定义、GL03/GL06 全站共用）
import '@/styles/shortcuts.css'

interface ChatItem {
  id: string
  title: string
}

interface Command {
  id: string
  label: string
  hint?: string
  group: string
  icon: Parameters<typeof Icon>[0]['name']
  keywords?: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [chats, setChats] = useState<ChatItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const navigate = useCallback(
    (href: string) => {
      router.push(href)
      onClose()
    },
    [router, onClose],
  )

  // Build the static command set (navigation + actions) from NAV.
  const navCommands = useMemo<Command[]>(() => {
    const cmds: Command[] = []
    for (const section of NAV) {
      for (const item of section.items) {
        cmds.push({
          id: `nav-${item.id}`,
          label: item.label,
          hint: '跳转',
          group: '页面',
          icon: item.icon,
          run: () => navigate(item.href),
        })
      }
    }
    // Extra pages not in the primary NAV.
    cmds.push({
      id: 'nav-home',
      label: '首页',
      hint: '跳转',
      group: '页面',
      icon: 'chat',
      run: () => navigate('/'),
    })
    cmds.push({
      id: 'nav-settings',
      label: '设置',
      hint: '跳转',
      group: '页面',
      icon: 'settings',
      run: () => navigate('/settings'),
    })
    // Quick actions.
    cmds.push({
      id: 'act-new-chat',
      label: '新建对话',
      hint: '操作',
      group: '操作',
      icon: 'plus',
      keywords: 'new chat 对话',
      run: () => navigate('/'),
    })
    cmds.push({
      id: 'act-new-agent',
      label: '新建 Agent',
      hint: '操作',
      group: '操作',
      icon: 'plus',
      keywords: 'new agent 代理',
      run: () => navigate('/agents'),
    })
    cmds.push({
      id: 'act-new-flow',
      label: '新建 Flow',
      hint: '操作',
      group: '操作',
      icon: 'plus',
      keywords: 'new flow 工作流',
      run: () => navigate('/flows'),
    })
    return cmds
  }, [navigate])

  // Live chat search when the query looks like free text (≥1 char).
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActive(0)
      setChats([])
      return
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setChats([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(`/api/chats?q=${encodeURIComponent(q)}&limit=8`)
        if (!r.ok) return
        const j = await r.json()
        const items: ChatItem[] = j?.data?.chats ?? j?.data?.items ?? []
        if (!cancelled) setChats(items.slice(0, 6))
      } catch {
        if (!cancelled) setChats([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [query, open])

  const chatCommands = useMemo<Command[]>(() => {
    return chats.map((c) => ({
      id: `chat-${c.id}`,
      label: c.title || '无标题对话',
      hint: '对话',
      group: '对话',
      icon: 'chat' as const,
      keywords: c.title,
      run: () => navigate(`/chats/${c.id}`),
    }))
  }, [chats, navigate])

  const filteredNav = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return navCommands
    return navCommands.filter((cmd) => {
      const hay = `${cmd.label} ${cmd.group} ${cmd.keywords ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [navCommands, query])

  const commands = useMemo(
    () => [...chatCommands, ...filteredNav],
    [chatCommands, filteredNav],
  )

  // Clamp active index when the filtered set changes.
  useEffect(() => {
    setActive((prev) => (prev >= commands.length ? 0 : prev))
  }, [commands.length])

  // Keyboard handling at the palette level: Esc closes, arrows move,
  // Enter runs the highlighted command.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (commands.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % commands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + commands.length) % commands.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = commands[active]
        if (cmd) cmd.run()
      }
    },
    [commands, active, onClose],
  )

  // Focus the input on open + reset selection.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
      setActive(0)
    }
  }, [open])

  // Scroll the active item into view when the selection moves.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${active}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  // Group commands by `group` preserving the order they appear in `commands`.
  const grouped: { group: string; items: { cmd: Command; idx: number }[] }[] = []
  let runningIdx = 0
  for (const cmd of commands) {
    let bucket = grouped.find((g) => g.group === cmd.group)
    if (!bucket) {
      bucket = { group: cmd.group, items: [] }
      grouped.push(bucket)
    }
    bucket.items.push({ cmd, idx: runningIdx++ })
  }

  return (
    <div
      className="cmdk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('命令面板')}
      onClick={onClose}
    >
      <div className="cmdk" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="cmdk-input-wrap">
          <Icon name="search" className="cmdk-input-icon" />
          <input
            ref={inputRef}
            type="text"
            className="cmdk-input"
            placeholder={t('搜索页面、对话或操作…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('搜索命令')}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd cmdk-esc">ESC</kbd>
        </div>
        {commands.length === 0 ? (
          <div className="cmdk-empty">{t('没有匹配的命令')}</div>
        ) : (
          <div className="cmdk-list" ref={listRef}>
            {grouped.map((bucket) => (
              <div className="cmdk-group" key={bucket.group}>
                <div className="cmdk-group-label">{t(bucket.group)}</div>
                {bucket.items.map(({ cmd, idx }) => (
                  <button
                    key={cmd.id}
                    type="button"
                    className={`cmdk-item${idx === active ? ' is-active' : ''}`}
                    data-cmd-idx={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={cmd.run}
                  >
                    <span className="cmdk-item-icon">
                      <Icon name={cmd.icon} />
                    </span>
                    <span className="cmdk-item-label">{t(cmd.label)}</span>
                    {cmd.hint ? <span className="cmdk-item-hint">{t(cmd.hint)}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="cmdk-footer">
          <span className="cmdk-footer-hint">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd>
            {t('导航')}
          </span>
          <span className="cmdk-footer-hint">
            <kbd className="kbd">↵</kbd>
            {t('选择')}
          </span>
          <span className="cmdk-footer-hint">
            <kbd className="kbd">⌘K</kbd>
            {t('开合面板')}
          </span>
          <span className="cmdk-footer-brand">DAgent</span>
        </div>
      </div>
    </div>
  )
}
