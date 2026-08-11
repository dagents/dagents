'use client'

/**
 * Chat-First navigation sidebar (OpenWebUI paradigm).
 *
 * Dual-dimension structure:
 *   - Brand + New Chat + Search
 *   - Primary nav (Chat / Agents / AgentFlows / Daemons / Settings)
 *   - Chat history grouped by project directory (collapsible)
 *   - User footer
 *
 * Replaces the old ChatSidebar (flat list + dropdown).
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { NAV } from '@/components/nav'
import { useSession } from '@/lib/auth-client'
import { fetchDirectories, pickDirectory, createDirectory, type Directory } from '@/lib/directories'
import { fetchChats, createChat, updateChat, deleteChat, type Chat } from '@/lib/chats'
import { ThemeToggle } from '@/components/theme-toggle'
import { ChatSearchDropdown, type ChatSearchDropdownHandle } from '@/components/chat-search-dropdown'
import '@/styles/chat-nav-sidebar.css'

interface ChatNavSidebarProps {
  collapsed?: boolean
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

/** Compact relative time for chat history — "刚刚 / N分钟前 / N小时前 / 昨天 / M月D日". */
function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}小时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return '昨天'
  if (diffDay < 7) return `${diffDay}天前`
  const d = new Date(then)
  return `${d.getMonth() + 1}月${d.getDate()}日`
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

export function ChatNavSidebar({ collapsed }: ChatNavSidebarProps): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const { user } = useSession()
  const [directories, setDirectories] = useState<Directory[]>([])
  const [chatsByDir, setChatsByDir] = useState<Record<string, Chat[]>>({})
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchDropdownRef = useRef<ChatSearchDropdownHandle>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

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

  const toggleDir = useCallback((dirId: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirId)) next.delete(dirId)
      else next.add(dirId)
      return next
    })
  }, [])

  // Flat list of all chats across directories, newest first — used by the
  // search dropdown's "recent" mode (empty query). Capped at 20 so the
  // dropdown stays scrollable.
  const recentChats: Chat[] = useMemo(() => {
    const all = Object.values(chatsByDir).flat()
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return all.slice(0, 20)
  }, [chatsByDir])

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
    <div className="chat-nav-sidebar">
      {/* Brand */}
      <div className={`chat-nav-brand${collapsed ? ' collapsed' : ''}`}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <div className="chat-nav-brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
              <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
              <circle cx="18" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" fill="currentColor" stroke="none" />
              <path d="M7.5 7.5 L10.5 16" />
              <path d="M16.5 7.5 L13.5 16" />
              <path d="M8.5 6 L15.5 6" />
            </svg>
          </div>
          <span className="chat-nav-brand-name">Dagents</span>
        </Link>
      </div>

      {/* New Chat + Search */}
      <div className="chat-nav-actions">
        <button type="button" className="chat-nav-action-btn" onClick={handleNewChat}>
          <Icon name="pencil" className="nav-icon" style={{ width: 16, height: 16 }} />
          <span>新建对话</span>
        </button>
        {!collapsed && (
          <div className="chat-nav-search-wrap">
            <div className="chat-nav-search">
              <Icon name="search" style={{ width: 12, height: 12, color: 'var(--meta)' }} />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setSearchOpen(true)
                }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => {
                  // Delay close so click events on dropdown items fire first.
                  window.setTimeout(() => setSearchOpen(false), 150)
                }}
                onKeyDown={(e) => {
                  searchDropdownRef.current?.handleKeyDown(e)
                }}
                placeholder="搜索对话…"
                className="chat-nav-search-input"
              />
            </div>
            <ChatSearchDropdown
              ref={searchDropdownRef}
              query={search}
              open={searchOpen}
              onClose={() => {
                setSearchOpen(false)
                searchInputRef.current?.blur()
              }}
              recentChats={recentChats}
              activeChatId={activeChatId}
            />
          </div>
        )}
      </div>

      {/* Primary nav */}
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

      {/* Chat history grouped by directory.
          "添加项目目录" is pinned to the top so it's always reachable —
          previously it sat at the bottom of a long list and was hard to find.
          When the search dropdown is open with a query, the normal list is
          hidden so the dropdown's results are the single focus. */}
      <div className={`chat-nav-history${searchOpen && search.trim() ? ' is-searching' : ''}`}>
        <button
          type="button"
          className="chat-nav-add-dir"
          onClick={() => void handleAddDirectory()}
          disabled={addingDir}
          title="添加项目目录"
        >
          <Icon name="plus" style={{ width: 14, height: 14 }} />
          <span>{addingDir ? '等待选择…' : '添加项目目录'}</span>
        </button>

        {loading ? (
          <div style={{ padding: 'var(--space-3)', color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>加载中…</div>
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
            return (
              <div key={dir.id} className="chat-nav-dir-group">
                <div className="chat-nav-dir-header-row">
                  <button
                    type="button"
                    className="chat-nav-dir-header"
                    onClick={() => toggleDir(dir.id)}
                    title={dir.path || dir.name}
                  >
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} style={{ width: 12, height: 12 }} />
                    <Icon name="folder" style={{ width: 14, height: 14 }} />
                    <span>{dir.name}</span>
                    <span className="chat-nav-dir-count">{chats.length}</span>
                  </button>
                  {/* Per-directory new-chat ➕ — creates a chat bound to this
                      directory and jumps straight into it. stopPropagation so
                      clicking ➕ doesn't also collapse/expand the group. */}
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
                    {chats.map((chat) => (
                      <div
                        key={chat.id}
                        className="chat-nav-chat-item-wrapper"
                      >
                        {renamingId === chat.id ? (
                          // Inline rename input
                          <input
                            type="text"
                            className="chat-nav-chat-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void confirmRename(chat.id)
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
                              title={sanitizeChatTitle(chat.title, 200)}
                            >
                              <span className={`chat-nav-chat-status ${chat.status}`} />
                              <span className="chat-nav-chat-item-title">{sanitizeChatTitle(chat.title)}</span>
                              <span className="chat-nav-chat-item-meta">
                                <span className="chat-nav-chat-item-time">{formatRelativeTime(chat.updatedAt)}</span>
                              </span>
                            </Link>
                            <div className="chat-nav-chat-actions">
                              <button
                                type="button"
                                className="chat-nav-chat-action-btn"
                                title="重命名"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); startRename(chat) }}
                              >
                                <Icon name="pencil" style={{ width: 12, height: 12 }} />
                              </button>
                              <button
                                type="button"
                                className="chat-nav-chat-action-btn chat-nav-chat-action-danger"
                                title="删除"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeletingId(chat.id) }}
                              >
                                <Icon name="close" style={{ width: 12, height: 12 }} />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* User footer */}
      <div className="chat-nav-footer">
        <Link href={user ? '/' : '/login'} className="chat-nav-user">
          <div
            className="chat-nav-user-avatar"
            data-authed={user ? 'true' : 'false'}
            title={user ? undefined : '未登录 — 点击登录'}
          >
            {user ? (
              user.name.slice(0, 1).toUpperCase()
            ) : (
              <Icon name="user" style={{ width: 14, height: 14 }} />
            )}
          </div>
          <div className="chat-nav-user-info">
            <span className="chat-nav-user-name">{user?.name ?? '未登录'}</span>
            <span className="chat-nav-user-plan">{user ? '专业版' : '点击登录'}</span>
          </div>
        </Link>
        <ThemeToggle />
        <Link
          href="/settings"
          className="chat-nav-settings-btn"
          aria-label="设置"
          title="设置"
          aria-current={isActive(pathname, '/settings') ? 'page' : undefined}
        >
          <Icon name="settings" className="nav-icon" style={{ width: 16, height: 16 }} />
        </Link>
      </div>
    </div>
  )
}
