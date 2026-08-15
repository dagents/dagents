'use client'

/**
 * Chat-First navigation sidebar — deepseek-harness session-browser paradigm.
 *
 * Structure:
 *   - Brand + New Chat + morphing search capsule
 *   - Primary nav (Agents / Flows / Daemons — ours alone)
 *   - Chat history grouped by project directory, deepseek row anatomy:
 *     34px group header (folder ↔ chevron hover swap) + 32px chat rows
 *     (status-dot slot + title + compact time that yields to hover actions),
 *     5 rows per group with a "显示更多" overflow control, and the active
 *     chat's group auto-expands once on navigation.
 *   - User footer
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { HoverCard } from '@/components/hover-card'
import { NAV } from '@/components/nav'
import { fetchDirectories, pickDirectory, createDirectory, updateDirectory, deleteDirectory, type Directory } from '@/lib/directories'
import { fetchChats, createChat, updateChat, deleteChat, type Chat } from '@/lib/chats'
import { ThemeToggle } from '@/components/theme-toggle'
import { ChatSearchDropdown, type ChatSearchDropdownHandle } from '@/components/chat-search-dropdown'
import '@/styles/chat-nav-sidebar.css'

interface ChatNavSidebarProps {
  collapsed?: boolean
  /** Toggle the sidebar — the expanded brand row's panel button collapses
   *  it (deepseek seats the toggle in the logo row); the collapsed rail's
   *  logo is the expand side of the same toggle. */
  onToggle?: () => void
}

/** Rows shown per directory before the overflow control (deepseek
 *  COLLAPSED_SESSION_LIMIT). */
const CHAT_LIMIT = 5

const CHAT_STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  failed: '失败',
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

/** Compact relative time (deepseek tree.ts relativeTime buckets) — single-
 *  char units fit the 32px row: 刚刚 / 5分 / 3时 / 2天 / 4月 / 1年. */
function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.max(0, now - then)
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}时`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天`
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}月`
  return `${Math.floor(diff / (365 * DAY))}年`
}

/**
 * Sanitize a chat title for safe display:
 * 1. Strip HTML tags to block XSS payloads rendered as plain text
 * 2. Collapse excessive whitespace
 * 3. Hard-cap length to avoid layout breakage (CSS ellipsis handles the rest visually)
 */
function sanitizeChatTitle(raw: string, max = 80): string {
  if (!raw) return '新对话'
  const stripped = raw.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return '新对话'
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed
}

export function ChatNavSidebar({ collapsed, onToggle }: ChatNavSidebarProps): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const [directories, setDirectories] = useState<Directory[]>([])
  const [chatsByDir, setChatsByDir] = useState<Record<string, Chat[]>>({})
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  // Directories whose overflow control is opened (show all chats).
  const [fullDirs, setFullDirs] = useState<Set<string>>(new Set())
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // Morphing search capsule (deepseek): collapsed it is a round icon button;
  // clicking grows it into the bordered input. Escape collapses.
  const [searchExpanded, setSearchExpanded] = useState(false)
  const searchDropdownRef = useRef<ChatSearchDropdownHandle>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
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

  // Extract active chat id from pathname /chats/:id
  useEffect(() => {
    const match = pathname.match(/^\/chats\/([^/]+)/)
    setActiveChatId(match?.[1] ?? null)
  }, [pathname])

  // Fetch directories
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setDirectories(dirs)
        // Expand the first directory by default
        if (dirs.length > 0) {
          setExpandedDirs(new Set([dirs[0]!.id]))
        }
      } catch {
        // silent — sidebar shows empty state
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Fetch chats for all directories (lightweight — directories are few)
  useEffect(() => {
    if (directories.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        directories.map(async (dir) => {
          try {
            const chats = await fetchChats(dir.id)
            return [dir.id, chats] as const
          } catch {
            return [dir.id, [] as Chat[]] as const
          }
        }),
      )
      if (cancelled) return
      const map: Record<string, Chat[]> = {}
      for (const [id, chats] of entries) map[id] = chats
      setChatsByDir(map)
    })()
    return () => { cancelled = true }
  }, [directories])

  // Auto-expand the directory containing the active chat — once per
  // navigation (deepseek: clicking a session expands its group; a manual
  // collapse afterwards is respected until the next navigation).
  const autoExpandedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeChatId || autoExpandedRef.current === activeChatId) return
    for (const [dirId, chats] of Object.entries(chatsByDir)) {
      if (chats.some((c) => c.id === activeChatId)) {
        autoExpandedRef.current = activeChatId
        setExpandedDirs((prev) => new Set(prev).add(dirId))
        break
      }
    }
  }, [activeChatId, chatsByDir])

  const toggleDir = useCallback((dirId: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirId)) next.delete(dirId)
      else next.add(dirId)
      return next
    })
  }, [])

  const toggleFullDir = useCallback((dirId: string) => {
    setFullDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirId)) next.delete(dirId)
      else next.add(dirId)
      return next
    })
  }, [])

  // Reload directories after an inline action (add dir / new chat) so the
  // sidebar reflects the new state without a full page refresh.
  const reloadDirectories = useCallback(async () => {
    try {
      const dirs = await fetchDirectories()
      setDirectories(dirs)
      const entries = await Promise.all(
        dirs.map(async (dir) => {
          try {
            const chats = await fetchChats(dir.id)
            return [dir.id, chats] as const
          } catch {
            return [dir.id, [] as Chat[]] as const
          }
        }),
      )
      const map: Record<string, Chat[]> = {}
      for (const [id, chats] of entries) map[id] = chats
      setChatsByDir(map)
    } catch {
      // silent — sidebar keeps stale data
    }
  }, [])

  const handleNewChat = useCallback(() => {
    router.push('/')
  }, [router])

  // ─── chat rename / delete ──────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // IME guard for the inline rename's Enter (deepseek rename composingRef).
  const renameComposingRef = useRef(false)

  const startRename = useCallback((chat: Chat) => {
    setRenamingId(chat.id)
    setRenameValue(chat.title)
  }, [])

  const confirmRename = useCallback(async (chatId: string) => {
    const title = renameValue.trim()
    if (!title) {
      setRenamingId(null)
      return
    }
    try {
      await updateChat(chatId, { title })
      // Update local state
      setChatsByDir((prev) => {
        const next: Record<string, Chat[]> = {}
        for (const [dirId, chats] of Object.entries(prev)) {
          next[dirId] = chats.map((c) => (c.id === chatId ? { ...c, title } : c))
        }
        return next
      })
    } catch {
      // silent — keeps old title
    }
    setRenamingId(null)
  }, [renameValue])

  const confirmDelete = useCallback(async (chatId: string) => {
    try {
      await deleteChat(chatId)
      setChatsByDir((prev) => {
        const next: Record<string, Chat[]> = {}
        for (const [dirId, chats] of Object.entries(prev)) {
          next[dirId] = chats.filter((c) => c.id !== chatId)
        }
        return next
      })
      // If deleting the active chat, navigate to home
      if (activeChatId === chatId) {
        router.push('/')
      }
    } catch {
      // silent — chat stays in list
    }
    setDeletingId(null)
  }, [activeChatId, router])

  // Create a fresh chat bound to a specific directory and navigate into it.
  // Used by the ➕ icon on each directory header. The directory auto-expands
  // so the new chat appears under it immediately after navigation back.
  const [creatingInDir, setCreatingInDir] = useState<string | null>(null)
  const handleNewChatInDir = useCallback(
    async (dirId: string) => {
      if (creatingInDir) return
      setCreatingInDir(dirId)
      try {
        const chat = await createChat({ directoryId: dirId, title: '新对话' })
        // Prepend into local state so it shows up instantly after navigation.
        setChatsByDir((prev) => ({
          ...prev,
          [dirId]: [chat, ...(prev[dirId] ?? [])],
        }))
        setExpandedDirs((prev) => new Set(prev).add(dirId))
        router.push(`/chats/${chat.id}`)
      } catch {
        // silent — the user can retry from the home composer
      } finally {
        setCreatingInDir(null)
      }
    },
    [creatingInDir, router],
  )

  // ─── directory-level menu: rename (inline) / delete (confirm modal) ───
  const [dirMenu, setDirMenu] = useState<{ id: string; top: number; left: number } | null>(null)
  const [renamingDirId, setRenamingDirId] = useState<string | null>(null)
  const [renameDirValue, setRenameDirValue] = useState('')
  const [deletingDir, setDeletingDir] = useState<Directory | null>(null)
  const [deletingDirPending, setDeletingDirPending] = useState(false)

  const openDirMenu = useCallback((dirId: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect()
    // Below-right of the ellipsis, clamped into the viewport.
    setDirMenu({
      id: dirId,
      top: Math.min(r.bottom + 4, window.innerHeight - 96),
      left: Math.min(r.left, window.innerWidth - 160),
    })
  }, [])

  // Click-away closes the menu (deepseek Menu closeOnPointerLeave analogue).
  useEffect(() => {
    if (!dirMenu) return
    const close = () => setDirMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [dirMenu])

  const startRenameDir = useCallback((dir: Directory) => {
    setRenamingDirId(dir.id)
    setRenameDirValue(dir.name)
  }, [])

  const confirmRenameDir = useCallback(async (dirId: string) => {
    const name = renameDirValue.trim()
    if (!name) {
      setRenamingDirId(null)
      return
    }
    try {
      const updated = await updateDirectory(dirId, { name })
      setDirectories((prev) => prev.map((d) => (d.id === dirId ? { ...d, name: updated.name } : d)))
    } catch {
      // silent — keeps old name
    }
    setRenamingDirId(null)
  }, [renameDirValue])

  const confirmDeleteDir = useCallback(async (dir: Directory) => {
    setDeletingDirPending(true)
    try {
      await deleteDirectory(dir.id)
      setDirectories((prev) => prev.filter((d) => d.id !== dir.id))
      setChatsByDir((prev) => {
        const next = { ...prev }
        delete next[dir.id]
        return next
      })
      // If the active chat lived in the deleted directory, it is gone with
      // the cascade — go home.
      const hadActive = (chatsByDir[dir.id] ?? []).some((c) => c.id === activeChatId)
      if (hadActive) router.push('/')
    } catch {
      // silent — directory stays; the modal stays open for a retry
      setDeletingDirPending(false)
      return
    }
    setDeletingDirPending(false)
    setDeletingDir(null)
  }, [activeChatId, chatsByDir, router])

  // Inline add-directory flow — same as ChatHome's, but lives in the sidebar
  // so the user can add a directory from anywhere without going to /directories.
  const [addingDir, setAddingDir] = useState(false)
  const handleAddDirectory = useCallback(async (): Promise<void> => {
    if (addingDir) return
    setAddingDir(true)
    try {
      const path = await pickDirectory()
      if (!path) return // user cancelled the OS dialog
      await createDirectory({ path })
      await reloadDirectories()
    } catch {
      // silent — keeps sidebar stable
    } finally {
      setAddingDir(false)
    }
  }, [addingDir, reloadDirectories])

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
            aria-label="展开侧栏"
            title="展开侧栏"
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
              aria-label="折叠侧栏"
              title="折叠侧栏"
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
          title={collapsed ? '新建对话' : undefined}
        >
          <Icon name="pencil" className="nav-icon" style={{ width: 14, height: 14 }} />
          <span>新建对话</span>
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
            title={collapsed ? item.label : undefined}
          >
            <Icon name={item.icon} className="nav-icon" style={{ width: 16, height: 16, flexShrink: 0 }} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* Session browser (deepseek WorkspaceBrowser): section header with
          label + morphing search + add-directory; the grouped tree below.
          While typing, the label collapses away so the field owns the row. */}
      <div className={`chat-nav-browser${searchExpanded || search ? ' searching' : ''}`}>
        <div className="chat-nav-browser-header">
          <span className="chat-nav-browser-label">对话</span>
          <div className={`chat-nav-search-wrap${searchExpanded || search ? ' expanded' : ''}`}>
            <div className="chat-nav-search">
              {searchExpanded || search ? (
                <>
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onBlur={() => {
                      // Outside click with an empty query collapses the
                      // capsule back to the round icon (deepseek search);
                      // a live query keeps the field open so the results
                      // stay readable.
                      if (!search) setSearchExpanded(false)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        // Escape clears and collapses (deepseek search).
                        setSearch('')
                        setSearchExpanded(false)
                        searchInputRef.current?.blur()
                        return
                      }
                      searchDropdownRef.current?.handleKeyDown(e)
                    }}
                    placeholder="搜索对话…"
                    className="chat-nav-search-input"
                    aria-label="搜索对话"
                  />
                  {search ? (
                    <button
                      type="button"
                      className="chat-nav-search-clear"
                      aria-label="清空搜索"
                      onClick={() => {
                        setSearch('')
                        searchInputRef.current?.focus()
                      }}
                    >
                      <Icon name="close" style={{ width: 10, height: 10 }} />
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  className="chat-nav-search-open"
                  aria-label="搜索对话"
                  onClick={() => {
                    setSearchExpanded(true)
                    requestAnimationFrame(() => searchInputRef.current?.focus())
                  }}
                >
                  <Icon name="search" style={{ width: 13, height: 13 }} />
                </button>
              )}
            </div>
          </div>
          {/* Add-workspace affordance (deepseek IconProjectAddOutline16) */}
          <button
            type="button"
            className="chat-nav-browser-add"
            onClick={() => void handleAddDirectory()}
            disabled={addingDir}
            title="添加项目目录"
            aria-label="添加项目目录"
          >
            <Icon name={addingDir ? 'loader' : 'plus'} style={{ width: 13, height: 13 }} />
          </button>
        </div>

        {/* deepseek search mode: a non-empty query swaps the directory tree
            for the inline results panel — no floating dropdown. */}
        {search.trim() ? (
          <ChatSearchDropdown
            ref={searchDropdownRef}
            query={search}
            onClose={() => {
              setSearch('')
              setSearchExpanded(false)
            }}
          />
        ) : (
        <div className="chat-nav-history" role="tree">
        {loading ? (
          <div className="chat-nav-history-status" role="status">加载中…</div>
        ) : directories.length === 0 ? (
          <div className="chat-nav-history-empty">
            暂无项目目录，点击上方按钮添加
          </div>
        ) : (
          directories.map((dir) => {
            const chats = (chatsByDir[dir.id] ?? []).filter((chat) =>
              chat.title.toLowerCase().includes(search.toLowerCase()),
            )
            const expanded = expandedDirs.has(dir.id)
            const isCreating = creatingInDir === dir.id
            const showAll = fullDirs.has(dir.id)
            const visibleChats = showAll ? chats : chats.slice(0, CHAT_LIMIT)
            const hiddenCount = chats.length - CHAT_LIMIT
            return (
              <div key={dir.id} className="chat-nav-dir-group" role="group">
                <div className="chat-nav-dir-header-row">
                  {renamingDirId === dir.id ? (
                    // Inline directory rename (Enter IME-guarded).
                    <input
                      type="text"
                      className="chat-nav-dir-rename-input"
                      value={renameDirValue}
                      onChange={(e) => setRenameDirValue(e.target.value)}
                      onCompositionStart={() => { renameComposingRef.current = true }}
                      onCompositionEnd={() => { renameComposingRef.current = false }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !renameComposingRef.current) {
                          e.preventDefault()
                          void confirmRenameDir(dir.id)
                        }
                        if (e.key === 'Escape') setRenamingDirId(null)
                      }}
                      onBlur={() => void confirmRenameDir(dir.id)}
                      autoFocus
                      aria-label="目录名称"
                    />
                  ) : (
                    <button
                      type="button"
                      className="chat-nav-dir-header"
                      onClick={() => toggleDir(dir.id)}
                      title={dir.path || dir.name}
                      aria-expanded={expanded}
                      role="treeitem"
                    >
                      {/* Hover swap (deepseek ProjectRow): folder icon ↔
                          chevron, pure CSS. Chevron rotates open. */}
                      <span className="chat-nav-dir-slot folder">
                        <Icon name="folder" style={{ width: 14, height: 14 }} />
                      </span>
                      <span className="chat-nav-dir-slot chevron">
                        <Icon
                          name="chevronRight"
                          className={`chat-nav-dir-arrow${expanded ? ' open' : ''}`}
                          style={{ width: 12, height: 12 }}
                        />
                      </span>
                      <span className="chat-nav-dir-name">{dir.name}</span>
                      <span className="chat-nav-dir-count">{chats.length}</span>
                    </button>
                  )}
                  {/* Workspace menu (deepseek): rename / delete, hover-revealed. */}
                  {renamingDirId !== dir.id && (
                    <button
                      type="button"
                      className="chat-nav-dir-menu-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.currentTarget.dataset.stay = '1'
                        if (dirMenu?.id === dir.id) setDirMenu(null)
                        else openDirMenu(dir.id, e.currentTarget)
                      }}
                      title="目录操作"
                      aria-label={`「${dir.name}」目录操作`}
                      aria-haspopup="menu"
                    >
                      <Icon name="ellipsis" style={{ width: 14, height: 14 }} />
                    </button>
                  )}
                  {/* Per-directory new-chat ➕ — creates a chat bound to this
                      directory and jumps straight into it. */}
                  <button
                    type="button"
                    className="chat-nav-dir-new-chat"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleNewChatInDir(dir.id)
                    }}
                    disabled={isCreating}
                    title={`在「${dir.name}」中新建对话`}
                    aria-label={`在「${dir.name}」中新建对话`}
                  >
                    <Icon name={isCreating ? 'loader' : 'plus'} style={{ width: 12, height: 12 }} />
                  </button>
                </div>
                {expanded && (
                  <div className="chat-nav-dir-items">
                    {visibleChats.map((chat) => (
                      <HoverCard
                        key={chat.id}
                        delayMs={600}
                        disabled={renamingId === chat.id || deletingId === chat.id}
                        content={
                          <ChatHoverContent
                            title={sanitizeChatTitle(chat.title, 120)}
                            time={formatRelativeTime(chat.updatedAt)}
                            dirName={dir.name}
                            dirPath={dir.path}
                            status={chat.status}
                          />
                        }
                      >
                      <div
                        className="chat-nav-chat-item-wrapper"
                      >
                        {renamingId === chat.id ? (
                          // Inline rename input (Enter IME-guarded)
                          <input
                            type="text"
                            className="chat-nav-chat-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onCompositionStart={() => { renameComposingRef.current = true }}
                            onCompositionEnd={() => { renameComposingRef.current = false }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !renameComposingRef.current) {
                                e.preventDefault()
                                void confirmRename(chat.id)
                              }
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                            onBlur={() => void confirmRename(chat.id)}
                            autoFocus
                          />
                        ) : deletingId === chat.id ? (
                          // Delete confirmation
                          <div className="chat-nav-chat-delete-confirm">
                            <span>删除此对话？</span>
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => void confirmDelete(chat.id)}>删除</button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeletingId(null)}>取消</button>
                          </div>
                        ) : (
                          <>
                            <Link
                              href={`/chats/${chat.id}`}
                              className="chat-nav-chat-item"
                              aria-selected={activeChatId === chat.id}
                              role="treeitem"
                              title={sanitizeChatTitle(chat.title, 200)}
                            >
                              {/* Status-dot slot — 16px, aligns titles under
                                  the group name (deepseek .slot). */}
                              <span className={`chat-nav-chat-status ${chat.status}`} />
                              <span className="chat-nav-chat-item-title">{sanitizeChatTitle(chat.title)}</span>
                              {/* Time yields its seat to the hover actions
                                  (deepseek .time swap). */}
                              <span className="chat-nav-chat-item-time">{formatRelativeTime(chat.updatedAt)}</span>
                              <span className="chat-nav-chat-actions">
                                <button
                                  type="button"
                                  className="chat-nav-chat-action-btn"
                                  title="重命名"
                                  aria-label={`重命名 ${sanitizeChatTitle(chat.title, 20)}`}
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); startRename(chat) }}
                                >
                                  <Icon name="pencil" style={{ width: 12, height: 12 }} />
                                </button>
                                <button
                                  type="button"
                                  className="chat-nav-chat-action-btn chat-nav-chat-action-danger"
                                  title="删除"
                                  aria-label={`删除 ${sanitizeChatTitle(chat.title, 20)}`}
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeletingId(chat.id) }}
                                >
                                  <Icon name="close" style={{ width: 12, height: 12 }} />
                                </button>
                              </span>
                            </Link>
                          </>
                        )}
                      </div>
                      </HoverCard>
                    ))}
                    {!showAll && hiddenCount > 0 ? (
                      <button
                        type="button"
                        className="chat-nav-dir-overflow"
                        onClick={() => toggleFullDir(dir.id)}
                      >
                        显示更多 {hiddenCount} 个对话
                      </button>
                    ) : showAll && hiddenCount > 0 ? (
                      <button
                        type="button"
                        className="chat-nav-dir-overflow"
                        onClick={() => toggleFullDir(dir.id)}
                      >
                        收起
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })
        )}
          {/* Bottom gradient fade (deepseek .fade) — rows dissolve under the
              sidebar edge; padding keeps the last row clear of the veil. */}
          <span className="chat-nav-history-fade" aria-hidden="true" />
        </div>
        )}
      </div>

      {/* Workspace menu portal (deepseek Menu): rename / delete. */}
      {dirMenu && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="chat-nav-dir-menu"
              style={{ top: dirMenu.top, left: dirMenu.left }}
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const dir = directories.find((d) => d.id === dirMenu.id)
                  if (dir) startRenameDir(dir)
                  setDirMenu(null)
                }}
              >
                <Icon name="pencil" style={{ width: 12, height: 12 }} />
                <span>重命名目录</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  const dir = directories.find((d) => d.id === dirMenu.id)
                  if (dir) setDeletingDir(dir)
                  setDirMenu(null)
                }}
              >
                <Icon name="close" style={{ width: 12, height: 12 }} />
                <span>删除目录…</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {/* Directory delete confirm (deepseek workspace-delete modal): the
          DB cascade removes the directory's chats too — say so, keep the
          modal open until the deletion settles. */}
      {deletingDir && typeof document !== 'undefined'
        ? createPortal(
            <div className="chat-nav-confirm-overlay" onClick={() => { if (!deletingDirPending) setDeletingDir(null) }}>
              <div
                className="chat-nav-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-label="删除目录"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="chat-nav-confirm-title">删除目录「{deletingDir.name}」？</div>
                <div className="chat-nav-confirm-desc">
                  将同时删除其中 {(chatsByDir[deletingDir.id] ?? []).length} 个对话，此操作不可撤销。
                </div>
                <div className="chat-nav-confirm-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={deletingDirPending}
                    onClick={() => setDeletingDir(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={deletingDirPending}
                    onClick={() => void confirmDeleteDir(deletingDir)}
                  >
                    {deletingDirPending ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* Footer seat (deepseek): just the controls — 本机模式 has no user.
          Settings anchors the left end, theme toggle the right. */}
      <div className="chat-nav-footer">
        <Link
          href="/settings"
          className="chat-nav-settings-btn"
          aria-label="设置"
          title="设置"
          aria-current={isActive(pathname, '/settings') ? 'page' : undefined}
        >
          <Icon name="settings" className="nav-icon" style={{ width: 15, height: 15 }} />
        </Link>
        <ThemeToggle />
      </div>
    </div>
  )
}

/** HoverCard content for a chat row (deepseek SessionHoverContent): title,
 *  relative time + directory, path, status dot, and a copy-title affordance
 *  reachable by moving onto the card. */
function ChatHoverContent({
  title,
  time,
  dirName,
  dirPath,
  status,
}: {
  title: string
  time: string
  dirName: string
  dirPath?: string | null
  status: string
}): React.ReactNode {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timerRef.current), [])
  const onCopy = () => {
    if (copied) return
    void navigator.clipboard.writeText(title).then(() => {
      setCopied(true)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      // clipboard unavailable — silent
    })
  }
  return (
    <>
      <div className="hover-card-title">{title}</div>
      <div className="hover-card-meta">{time} · {dirName}</div>
      {dirPath ? <div className="hover-card-path">{dirPath}</div> : null}
      <div className={`hover-card-status ${status}`}>
        <span className="dot" aria-hidden="true" />
        {CHAT_STATUS_LABEL[status] ?? status}
      </div>
      <button
        type="button"
        className={`hover-card-copy${copied ? ' copied' : ''}`}
        onClick={onCopy}
      >
        <Icon name={copied ? 'check' : 'copy'} style={{ width: 10, height: 10 }} />
        <span>{copied ? '已复制' : '复制标题'}</span>
      </button>
    </>
  )
}
