'use client'

/**
 * Chat-First global layout (OpenWebUI paradigm).
 *
 * Replaces the old AppShell (3-grid: sidebar + topbar + main) with a
 * 2-pane layout: sidebar + main. The sidebar is the new ChatNavSidebar
 * (dual-dimension: directories → chats). The main pane is pure page
 * content — the slim navbar was removed (chat pages carry their own
 * breadcrumb; ⌘K still opens the command palette from any route).
 */

import { useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { ChatNavSidebar } from '@/components/chat-nav-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts'
import { FloatingChat } from '@/components/floating-chat'
import { useI18n } from '@/i18n'
import '@/styles/chat-layout.css'

const COLLAPSE_KEY = 'od:chat-sidebar'

export function ChatLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname() // subscribe to route changes so the layout re-renders per page
  const [collapsed, setCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Mobile drawer (<768px). The CSS side (off-canvas + `sidebar-open` class)
  // existed already; this state is the missing JS trigger that makes the
  // sidebar REACHABLE on narrow viewports.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
  }, [])

  // Navigating from the drawer closes it — the destination page owns the
  // viewport again (covers both nav links and the chat tree).
  useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  // Global Cmd/Ctrl+K to open the command palette. Mounted once at the
  // layout root so it works on every route. Prevents the browser default
  // (often a page search bar) when the palette is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'open')
      return next
    })
  }, [])

  return (
    <div className={`chat-layout${mobileNavOpen ? ' sidebar-open' : ''}`}>
      {/* Mobile-only hamburger. Desktop hides it via CSS; when the drawer is
          open the backdrop (higher z) covers it, so no toggling needed. */}
      <button
        type="button"
        className="chat-mobile-nav-toggle"
        aria-label={t('打开导航')}
        onClick={() => setMobileNavOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      {mobileNavOpen && (
        <button
          type="button"
          className="chat-layout-backdrop"
          aria-label={t('关闭导航')}
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside className={`chat-layout-sidebar${collapsed ? ' collapsed' : ''}`}>
        <ChatNavSidebar collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>
      <div className="chat-layout-main">
        <div className="chat-layout-content">
          {children}
        </div>
      </div>
      {/* Floating chat overlay — multica-style FAB + window. Hidden on
          /chats/[id] (the full-page chat owns the conversation there). */}
      <FloatingChat />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <KeyboardShortcuts />
    </div>
  )
}
