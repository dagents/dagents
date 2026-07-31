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

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { ChatNavSidebar } from '@/components/chat-nav-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { FloatingChat } from '@/components/floating-chat'
import { Icon } from '@/components/icon'
import { crumbsFor } from '@/components/nav'
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
  const [collapsed, setCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
  }, [])

  // Toggle a hairline under the navbar once the content scrolls. The CSS
  // (.chat-layout-navbar.scrolled) already defines the border; this listener
  // just flips the class. Threshold of 4px avoids flicker on tiny scrolls.
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrolled(el.scrollTop > 4)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

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

  const title = useMemo(() => titleFor(pathname), [pathname])

  return (
    <div className="chat-layout">
      <aside className={`chat-layout-sidebar${collapsed ? ' collapsed' : ''}`}>
        <ChatNavSidebar collapsed={collapsed} />
      </aside>
      <div className="chat-layout-main">
        <header className={`chat-layout-navbar${scrolled ? ' scrolled' : ''}`}>
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
            <button
              type="button"
              className="chat-layout-search"
              onClick={() => setPaletteOpen(true)}
              aria-label="打开命令面板"
              title="命令面板 (⌘K)"
            >
              <Icon name="search" style={{ width: 15, height: 15, color: 'var(--muted)' }} />
              <span className="chat-layout-search-text">搜索…</span>
              <kbd className="chat-layout-search-kbd">⌘K</kbd>
            </button>
          </div>
        </header>
        <div className="chat-layout-content" ref={contentRef}>
          {children}
        </div>
      </div>
      {/* Floating chat overlay — multica-style FAB + window. Hidden on
          /chats/[id] (the full-page chat owns the conversation there). */}
      <FloatingChat />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
