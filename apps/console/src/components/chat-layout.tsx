'use client'

/**
 * 全局布局 —— IA 开关的双壳（docs/prd-workflow-first.md）。
 *
 * Workflow-First（默认，`dagents.ia.workflow-first=on`）：AppNavSidebar
 * （工作流 / 模板 / 运行历史 / Agents / 技能 / Daemons + 最近对话折叠）。
 * Chat-First（`off`，P3 观察期回滚通道）：旧 ChatNavSidebar（目录→会话树）。
 *
 * 两态共用：FAB 悬浮副驾、命令面板（⌘K）、快捷键帮助（?）、移动端抽屉。
 * 主内容区与折叠持久化（od:chat-sidebar）不变。
 */
import { useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { ChatNavSidebar } from '@/components/chat-nav-sidebar'
import { AppNavSidebar } from '@/components/app-nav-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts'
import { FloatingChat } from '@/components/floating-chat'
import { isWorkflowFirstIA } from '@/lib/ia-flag'
import '@/styles/chat-layout.css'

const COLLAPSE_KEY = 'od:chat-sidebar'

export function ChatLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname() // subscribe to route changes so the layout re-renders per page
  const [collapsed, setCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // null = 首帧未定（SSR 水合安全）：渲染旧壳占位，挂载后立即校正
  const [wfIA, setWfIA] = useState<boolean | null>(null)
  // Mobile drawer (<768px). The CSS side (off-canvas + `sidebar-open` class)
  // existed already; this state is the missing JS trigger that makes the
  // sidebar REACHABLE on narrow viewports.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'collapsed')
    setWfIA(isWorkflowFirstIA())
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
        aria-label="打开导航"
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
          aria-label="关闭导航"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside className={`chat-layout-sidebar${collapsed ? ' collapsed' : ''}`}>
        {wfIA === false ? (
          <ChatNavSidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        ) : (
          <AppNavSidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        )}
      </aside>
      <div className="chat-layout-main">
        <div className="chat-layout-content">
          {children}
        </div>
      </div>
      {/* Floating chat overlay —— 双 IA 共用（新 IA 全路由常驻，旧 IA 管理
          页隐藏；隐藏策略在 FloatingChat 内部按 IA 分派）。 */}
      <FloatingChat />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <KeyboardShortcuts />
    </div>
  )
}
