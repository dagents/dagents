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
import { fetchChats, createChat, updateChat, deleteChat, CHAT_STATUS_LABEL, type Chat } from '@/lib/chats'
import { formatRelativeCompact } from '@/lib/format'
import { useToast } from '@/components/toast'
import { ThemeToggle } from '@/components/theme-toggle'
import { LocaleToggle } from '@/components/locale-toggle'
import { useI18n } from '@/i18n'
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

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

/** Per-directory chat fetch shared by the mount effect and reloads. */
async function fetchChatsByDirs(dirs: Directory[]): Promise<Record<string, Chat[]>> {
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
  return map
}

/**
 * Sanitize a chat title for safe display:
 * 1. Strip HTML tags to block XSS payloads rendered as plain text
 * 2. Collapse excessive whitespace
 * 3. Hard-cap length to avoid layout breakage (CSS ellipsis handles the rest visually)
 *
 * Returns '' for an unusable title — the RENDERER supplies the localized
 * 「新对话」 fallback (a module-level function can't call t()).
 */
function sanitizeChatTitle(raw: string, max = 80): string {
  if (!raw) return ''
  const stripped = raw.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return ''
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed
}

export function ChatNavSidebar({ collapsed, onToggle }: ChatNavSidebarProps): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  // Localized display title (sanitize + fallback) — one helper for every row.
  const displayTitle = useCallback(
    (raw: string, max?: number) => sanitizeChatTitle(raw, max) || t('新对话'),
    [t],
  )
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
        toast.error(t('项目目录加载失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [t, toast])

  // Fetch chats for all directories (lightweight — directories are few)
  const refreshChats = useCallback(async (): Promise<void> => {
    if (directories.length === 0) return
    setChatsByDir(await fetchChatsByDirs(directories))
  }, [directories])

  useEffect(() => {
    void refreshChats()
  }, [refreshChats])

  // Navigating to a chat that isn't in the loaded list means it was created
  // after mount (home composer → createChat → router.push keeps this layout
  // mounted, so the [directories] effect above never re-ran). Refetch once
  // per unknown id so new sessions appear in the history immediately.
  const refetchedIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeChatId || refetchedIdsRef.current.has(activeChatId)) return
    const known = Object.values(chatsByDir).some((chats) =>
      chats.some((c) => c.id === activeChatId),
    )
    if (!known) {
      refetchedIdsRef.current.add(activeChatId)
      void refreshChats()
    }
  }, [activeChatId, chatsByDir, refreshChats])

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
  // sidebar reflects the new state without a full page refresh. Shares the
  // per-dir chat fetch with refreshChats (was a verbatim duplicate).
  const reloadDirectories = useCallback(async () => {
    try {
      const dirs = await fetchDirectories()
      setDirectories(dirs)
      setChatsByDir(await fetchChatsByDirs(dirs))
    } catch {
      toast.error(t('项目目录刷新失败'))
    }
  }, [toast, t])

  const handleNewChat = useCallback(() => {
    router.push('/')
  }, [router])

  // ─── chat rename / delete ──────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // In-flight DELETE guard — the inline confirm buttons must not double-fire.
  const [deletingChatPending, setDeletingChatPending] = useState(false)
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
      toast.error(t('重命名失败'))
    }
    setRenamingId(null)
  }, [renameValue, toast, t])

  const confirmDelete = useCallback(async (chatId: string) => {
    if (deletingChatPending) return
    setDeletingChatPending(true)
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
      toast.error(t('删除对话失败'))
    }
    setDeletingChatPending(false)
    setDeletingId(null)
  }, [activeChatId, router, toast, t, deletingChatPending])

  // Create a fresh chat bound to a specific directory and navigate into it.
  // Used by the ➕ icon on each directory header. The directory auto-expands
  // so the new chat appears under it immediately after navigation back.
  const [creatingInDir, setCreatingInDir] = useState<string | null>(null)
  const handleNewChatInDir = useCallback(
    async (dirId: string) => {
      if (creatingInDir) return
      setCreatingInDir(dirId)
      try {
        const chat = await createChat({ directoryId: dirId, title: t('新对话') })
        // Prepend into local state so it shows up instantly after navigation.
        setChatsByDir((prev) => ({
          ...prev,
          [dirId]: [chat, ...(prev[dirId] ?? [])],
        }))
        setExpandedDirs((prev) => new Set(prev).add(dirId))
        router.push(`/chats/${chat.id}`)
      } catch {
        toast.error(t('新建对话失败'))
      } finally {
        setCreatingInDir(null)
      }
    },
    [creatingInDir, router, t, toast],
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

  // Click-away AND Escape close the menu (keyboard parity with the mouse).
  useEffect(() => {
    if (!dirMenu) return
    const close = () => setDirMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
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
      toast.error(t('重命名目录失败'))
    }
    setRenamingDirId(null)
  }, [renameDirValue, toast, t])

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
      toast.error(t('删除目录失败'))
      setDeletingDirPending(false)
      return
    }
    setDeletingDirPending(false)
    setDeletingDir(null)
  }, [activeChatId, chatsByDir, router, toast, t])

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
      toast.error(t('添加项目目录失败'))
    } finally {
      setAddingDir(false)
    }
  }, [addingDir, reloadDirectories, toast, t])

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

      {/* Session browser (deepseek WorkspaceBrowser): section header with
          label + morphing search + add-directory; the grouped tree below.
          While typing, the label collapses away so the field owns the row. */}
      <div className={`chat-nav-browser${searchExpanded || search ? ' searching' : ''}`}>
        <div className="chat-nav-browser-header">
          <span className="chat-nav-browser-label">{t('对话')}</span>
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
                    placeholder={t('搜索对话…')}
                    className="chat-nav-search-input"
                    aria-label={t('搜索对话')}
                  />
                  {search ? (
                    <button
                      type="button"
                      className="chat-nav-search-clear"
                      aria-label={t('清空搜索')}
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
                  aria-label={t('搜索对话')}
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
            title={t('添加项目目录')}
            aria-label={t('添加项目目录')}
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
        <div className="chat-nav-history" role="list" aria-label={t('对话列表')}>
        {loading ? (
          <div className="chat-nav-history-status" role="status">{t('加载中…')}</div>
        ) : directories.length === 0 ? (
          <div className="chat-nav-history-empty">
            {t('暂无项目目录，点击上方按钮添加')}
          </div>
        ) : (
          directories.map((dir) => {
            // This branch renders only when the search capsule is collapsed
            // (the dropdown owns results while typing) — no title filter here.
            const chats = chatsByDir[dir.id] ?? []
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
                      aria-label={t('目录名称')}
                    />
                  ) : (
                    <button
                      type="button"
                      className="chat-nav-dir-header"
                      onClick={() => toggleDir(dir.id)}
                      title={dir.path || dir.name}
                      aria-expanded={expanded}
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
                      title={t('目录操作')}
                      aria-label={t('「{name}」目录操作', { name: dir.name })}
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
                    title={t('在「{name}」中新建对话', { name: dir.name })}
                    aria-label={t('在「{name}」中新建对话', { name: dir.name })}
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
                            title={displayTitle(chat.title, 120)}
                            time={formatRelativeCompact(chat.updatedAt, t)}
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
                            <span>{t('删除此对话？')}</span>
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => void confirmDelete(chat.id)} disabled={deletingChatPending}>{deletingChatPending ? t('删除中…') : t('删除')}</button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeletingId(null)} disabled={deletingChatPending}>{t('取消')}</button>
                          </div>
                        ) : (
                          <>
                            <Link
                              href={`/chats/${chat.id}`}
                              className="chat-nav-chat-item"
                              aria-selected={activeChatId === chat.id}
                              aria-current={activeChatId === chat.id ? 'page' : undefined}
                              title={displayTitle(chat.title, 200)}
                            >
                              {/* Status-dot slot — 16px, aligns titles under
                                  the group name (deepseek .slot). */}
                              <span
                                className={`chat-nav-chat-status ${chat.status}`}
                                title={t(CHAT_STATUS_LABEL[chat.status as keyof typeof CHAT_STATUS_LABEL] ?? chat.status)}
                              />
                              <span className="chat-nav-chat-item-title">{displayTitle(chat.title)}</span>
                              {/* Time yields its seat to the hover actions
                                  (deepseek .time swap). */}
                              <span className="chat-nav-chat-item-time">{formatRelativeCompact(chat.updatedAt, t)}</span>
                              <span className="chat-nav-chat-actions">
                                <button
                                  type="button"
                                  className="chat-nav-chat-action-btn"
                                  title={t('重命名')}
                                  aria-label={t('重命名 {name}', { name: displayTitle(chat.title, 20) })}
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); startRename(chat) }}
                                >
                                  <Icon name="pencil" style={{ width: 12, height: 12 }} />
                                </button>
                                <button
                                  type="button"
                                  className="chat-nav-chat-action-btn chat-nav-chat-action-danger"
                                  title={t('删除')}
                                  aria-label={t('删除 {name}', { name: displayTitle(chat.title, 20) })}
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
                        {t('显示更多 {n} 个对话', { n: hiddenCount })}
                      </button>
                    ) : showAll && hiddenCount > 0 ? (
                      <button
                        type="button"
                        className="chat-nav-dir-overflow"
                        onClick={() => toggleFullDir(dir.id)}
                      >
                        {t('收起')}
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
                <span>{t('重命名目录')}</span>
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
                <span>{t('删除目录…')}</span>
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
            <div
              className="chat-nav-confirm-overlay"
              onClick={() => { if (!deletingDirPending) setDeletingDir(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !deletingDirPending) setDeletingDir(null)
              }}
            >
              <div
                className="chat-nav-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-label={t('删除目录')}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="chat-nav-confirm-title">{t('删除目录「{name}」？', { name: deletingDir.name })}</div>
                <div className="chat-nav-confirm-desc">
                  {t('将同时删除其中 {n} 个对话，此操作不可撤销。', { n: (chatsByDir[deletingDir.id] ?? []).length })}
                </div>
                <div className="chat-nav-confirm-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    ref={(el) => {
                      // Initial focus lands on the SAFE action so a keyboard
                      // user can't Enter-through into the destructive one.
                      if (el && !el.dataset.focused) {
                        el.dataset.focused = '1'
                        el.focus()
                      }
                    }}
                    disabled={deletingDirPending}
                    onClick={() => setDeletingDir(null)}
                  >
                    {t('取消')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={deletingDirPending}
                    onClick={() => void confirmDeleteDir(deletingDir)}
                  >
                    {deletingDirPending ? t('删除中…') : t('删除')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

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
  const { t } = useI18n()
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
        {t(CHAT_STATUS_LABEL[status as keyof typeof CHAT_STATUS_LABEL] ?? status)}
      </div>
      <button
        type="button"
        className={`hover-card-copy${copied ? ' copied' : ''}`}
        onClick={onCopy}
      >
        <Icon name={copied ? 'check' : 'copy'} style={{ width: 10, height: 10 }} />
        <span>{copied ? t('已复制') : t('复制标题')}</span>
      </button>
    </>
  )
}
