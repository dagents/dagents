'use client'

/**
 * Chat-First global layout (OpenWebUI paradigm).
 *
 * Replaces the old AppShell (3-grid: sidebar + topbar + main) with a
 * 2-pane layout: sidebar + main. The sidebar is the new ChatNavSidebar
 * (dual-dimension: directories → chats). The main pane has a slim navbar
 * (sidebar toggle + breadcrumb + user avatar) and the page content.
 *
 * Based on design-redo-open-webui/pages/main.html `.app-shell` layout.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { ChatNavSidebar } from '@/components/chat-nav-sidebar'
import { FloatingChat } from '@/components/floating-chat'
import { Icon } from '@/components/icon'
import { crumbsFor } from '@/components/nav'
import { useSession } from '@/lib/auth-client'
import '@/styles/chat-layout.css'

const COLLAPSE_KEY = 'od:chat-sidebar'

/** Derive the navbar title from the current pathname via the crumbs trail.
 *  Returns null for the root (Chat) — no title there. */
function titleFor(pathname: string): string | null {
  const segments = crumbsFor(pathname)
  if (segments.length === 0) return null
  return segments[segments.length - 1].label
}

export function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/'
  const { user, logout } = useSession()
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
  }, [])

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'open')
      return next
    })
  }, [])

  const title = useMemo(() => titleFor(pathname), [pathname])

  return (
    <div className="chat-layout">
      <aside className={`chat-layout-sidebar${collapsed ? ' collapsed' : ''}`}>
        <ChatNavSidebar collapsed={collapsed} />
      </aside>
      <div className="chat-layout-main">
        <header className="chat-layout-navbar">
          <div className="chat-layout-navbar-left">
            <button
              type="button"
              className="chat-layout-toggle"
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
              title={collapsed ? '展开侧栏' : '折叠侧栏'}
            >
              <Icon name="collapse" style={{ transform: collapsed ? 'rotate(180deg)' : '', transition: 'transform var(--motion-fast)' }} />
            </button>
            {title ? <h1 className="chat-layout-navbar-title">{title}</h1> : null}
          </div>
          <div className="chat-layout-navbar-right">
            <div className="account-menu-wrap" style={{ position: 'relative' }}>
              <button
                type="button"
                className="avatar"
                style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-xs)', fontWeight: 600, color: '#fff', background: 'linear-gradient(135deg, var(--fg), var(--accent))', border: 'none', cursor: 'pointer' }}
                aria-label="账户"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {user ? user.name.slice(0, 2).toUpperCase() : 'RZ'}
              </button>
              {menuOpen ? (
                <div className="account-menu" role="menu" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 'var(--space-1)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-dropdown)', minWidth: 160, zIndex: 100 }}>
                  <div className="account-menu-name" style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>{user?.name ?? '未登录'}</div>
                  <button type="button" role="menuitem" className="account-menu-item" style={{ display: 'block', width: '100%', padding: 'var(--space-2) var(--space-3)', border: 'none', background: 'transparent', textAlign: 'left', fontSize: 'var(--text-sm)', color: 'var(--fg)', cursor: 'pointer' }} onClick={() => { setMenuOpen(false); void logout() }}>
                    登出
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="chat-layout-content">
          {children}
        </div>
      </div>
      {/* Floating chat overlay — multica-style FAB + window. Hidden on
          /chats/[id] (the full-page chat owns the conversation there). */}
      <FloatingChat />
    </div>
  )
}
