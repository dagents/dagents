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
import '@/styles/chat-layout.css'

const COLLAPSE_KEY = 'od:chat-sidebar'

export function ChatLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  usePathname() // subscribe to route changes so the layout re-renders per page
  const [collapsed, setCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
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

  return (
    <div className="chat-layout">
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
