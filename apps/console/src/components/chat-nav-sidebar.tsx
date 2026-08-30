'use client'

/**
 * Chat-First navigation sidebar — deepseek-harness session-browser paradigm.
 *
 * Structure:
 *   - Brand + New Chat
 *   - Primary nav (Agents / Flows / Daemons — ours alone)
 *   - Chat history grouped by project directory — ChatHistoryTree (shared
 *     with AppNavSidebar since 2026-08-29; see chat-history-tree.tsx)
 *   - User footer
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { NAV } from '@/components/nav'
import { ThemeToggle } from '@/components/theme-toggle'
import { LocaleToggle } from '@/components/locale-toggle'
import { useI18n } from '@/i18n'
import { ChatHistoryTree } from '@/components/chat-history-tree'
import '@/styles/chat-nav-sidebar.css'

interface ChatNavSidebarProps {
  collapsed?: boolean
  /** Toggle the sidebar — the expanded brand row's panel button collapses
   *  it (deepseek seats the toggle in the logo row); the collapsed rail's
   *  logo is the expand side of the same toggle. */
  onToggle?: () => void
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function ChatNavSidebar({ collapsed, onToggle }: ChatNavSidebarProps): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const { t } = useI18n()

  // Quiet scrollbars (deepseek): the list's thumb stays transparent while
  // the pointer is outside the column, appearing with a 2s linger on leave.
  const [scrollActive, setScrollActive] = useState(false)
  const scrollLingerRef = useRef<number | undefined>(undefined)
  const onSidebarPointerEnter = useCallback(() => {
    window.clearTimeout(scrollLingerRef.current)
    setScrollActive(true)
  }, [])
  const onSidebarPointerLeave = useCallback(() => {
    window.clearTimeout(scrollLingerRef.current)
    scrollLingerRef.current = window.setTimeout(() => setScrollActive(false), 2000)
  }, [])
  useEffect(() => () => window.clearTimeout(scrollLingerRef.current), [])

  const handleNewChat = useCallback(() => {
    router.push('/')
  }, [router])

  return (
    <div
      className={`chat-nav-sidebar${scrollActive ? ' scroll-active' : ''}`}
      onPointerEnter={onSidebarPointerEnter}
      onPointerLeave={onSidebarPointerLeave}
    >
      {/* Brand (60px logo row — ours, deepseek geometry). Collapsed, the
          mark becomes the expand toggle and swaps to a panel icon on hover
          (deepseek rail). */}
      <div className={`chat-nav-brand${collapsed ? ' collapsed' : ''}`}>
        {collapsed ? (
          <button
            type="button"
            className="chat-nav-brand-rail"
            onClick={onToggle}
            aria-label={t('展开侧栏')}
            title={t('展开侧栏')}
          >
            <span className="chat-nav-brand-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
                <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
                <circle cx="18" cy="6" r="2.5" />
                <circle cx="12" cy="18" r="2.5" fill="currentColor" stroke="none" />
                <path d="M7.5 7.5 L10.5 16" />
                <path d="M16.5 7.5 L13.5 16" />
                <path d="M8.5 6 L15.5 6" />
              </svg>
            </span>
            <span className="chat-nav-brand-expand-icon" aria-hidden="true">
              <Icon name="panelLeft" style={{ width: 16, height: 16 }} />
            </span>
          </button>
        ) : (
          <>
            <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
              <span className="chat-nav-brand-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
                  <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
                  <circle cx="18" cy="6" r="2.5" />
                  <circle cx="12" cy="18" r="2.5" fill="currentColor" stroke="none" />
                  <path d="M7.5 7.5 L10.5 16" />
                  <path d="M16.5 7.5 L13.5 16" />
                  <path d="M8.5 6 L15.5 6" />
                </svg>
              </span>
              <span className="chat-nav-brand-name">Dagents</span>
            </Link>
            {/* Collapse toggle — deepseek seats it in the logo row (rail
                logo is the expand side). */}
            <button
              type="button"
              className="chat-nav-collapse-btn"
              onClick={onToggle}
              aria-label={t('折叠侧栏')}
              title={t('折叠侧栏')}
            >
              <Icon name="panelLeft" style={{ width: 15, height: 15 }} />
            </button>
          </>
        )}
      </div>

      {/* New Session (deepseek .newSession) */}
      <div className="chat-nav-actions">
        <button
          type="button"
          className="chat-nav-action-btn"
          onClick={handleNewChat}
          title={collapsed ? t('新建对话') : undefined}
        >
          <Icon name="pencil" className="nav-icon" style={{ width: 14, height: 14 }} />
          <span>{t('新建对话')}</span>
        </button>
      </div>

      {/* Our primary tabs — the one structural addition over deepseek */}
      <nav className="chat-nav-nav">
        {NAV.flatMap((group) => group.items).map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className="chat-nav-link"
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
            title={collapsed ? t(item.label) : undefined}
          >
            <Icon name={item.icon} className="nav-icon" style={{ width: 16, height: 16, flexShrink: 0 }} />
            <span>{t(item.label)}</span>
          </Link>
        ))}
      </nav>

      {/* Session history grouped by project directory (shared component). */}
      <ChatHistoryTree />

      {/* Footer seat (deepseek): just the controls — 本机模式 has no user.
          Settings anchors the left end, theme + locale toggle the right. */}
      <div className="chat-nav-footer">
        <Link
          href="/settings"
          className="chat-nav-settings-btn"
          aria-label={t('设置')}
          title={t('设置')}
          aria-current={isActive(pathname, '/settings') ? 'page' : undefined}
        >
          <Icon name="settings" className="nav-icon" style={{ width: 15, height: 15 }} />
        </Link>
        <LocaleToggle className="chat-nav-locale-btn" />
        <ThemeToggle />
      </div>
    </div>
  )
}
