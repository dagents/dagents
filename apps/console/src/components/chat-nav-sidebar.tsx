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

import { useEffect, useState, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { NAV } from '@/components/nav'
import { useSession } from '@/lib/auth-client'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { fetchChats, type Chat } from '@/lib/chats'
import '@/styles/chat-nav-sidebar.css'

interface ChatNavSidebarProps {
  collapsed?: boolean
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
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

  const handleNewChat = useCallback(() => {
    router.push('/')
  }, [router])

  return (
    <div className="chat-nav-sidebar">
      {/* Brand */}
      <div className={`chat-nav-brand${collapsed ? ' collapsed' : ''}`}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <div className="chat-nav-brand-mark">
            <Icon name="bot" className="nav-icon" style={{ width: 16, height: 16 }} />
          </div>
          <span className="chat-nav-brand-name">DAgent Console</span>
        </Link>
      </div>

      {/* New Chat + Search */}
      <div className="chat-nav-actions">
        <button type="button" className="chat-nav-action-btn" onClick={handleNewChat}>
          <Icon name="pencil" className="nav-icon" style={{ width: 16, height: 16 }} />
          <span>New Chat</span>
        </button>
        {!collapsed && (
          <div className="chat-nav-search">
            <Icon name="search" style={{ width: 12, height: 12, color: 'var(--meta)' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索对话…"
              className="chat-nav-search-input"
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
          >
            <Icon name={item.icon} className="nav-icon" style={{ width: 16, height: 16, flexShrink: 0 }} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* Chat history grouped by directory */}
      <div className="chat-nav-history">
        {loading ? (
          <div style={{ padding: 'var(--space-3)', color: 'var(--meta)', fontSize: 'var(--text-sm)' }}>Loading…</div>
        ) : directories.length === 0 ? (
          <Link href="/directories" className="chat-nav-add-dir">
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>添加项目目录</span>
          </Link>
        ) : (
          directories.map((dir) => {
            const chats = (chatsByDir[dir.id] ?? []).filter((chat) =>
              chat.title.toLowerCase().includes(search.toLowerCase()),
            )
            const expanded = expandedDirs.has(dir.id)
            return (
              <div key={dir.id} className="chat-nav-dir-group">
                <button
                  type="button"
                  className="chat-nav-dir-header"
                  onClick={() => toggleDir(dir.id)}
                >
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} style={{ width: 12, height: 12 }} />
                  <Icon name="folder" style={{ width: 14, height: 14 }} />
                  <span>{dir.name}</span>
                  <span className="chat-nav-dir-count">{chats.length}</span>
                </button>
                {expanded && (
                  <div className="chat-nav-dir-items">
                    {chats.map((chat) => (
                      <Link
                        key={chat.id}
                        href={`/chats/${chat.id}`}
                        className="chat-nav-chat-item"
                        aria-selected={activeChatId === chat.id}
                      >
                        <span className={`chat-nav-chat-status ${chat.status}`} />
                        <span className="chat-nav-chat-item-title">{chat.title}</span>
                        <span className="chat-nav-chat-item-meta">
                          <span className="chat-nav-chat-item-count">{chat.messageCount}</span>
                          <span className="chat-nav-chat-item-status">{chat.status}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
        {directories.length > 0 && (
          <Link href="/directories" className="chat-nav-add-dir">
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>添加项目目录</span>
          </Link>
        )}
      </div>

      {/* User footer */}
      <div className="chat-nav-footer">
        <Link href="/settings" className="chat-nav-user">
          <div className="chat-nav-user-avatar">
            {user ? user.name.slice(0, 1).toUpperCase() : 'R'}
          </div>
          <div className="chat-nav-user-info">
            <span className="chat-nav-user-name">{user?.name ?? '未登录'}</span>
            <span className="chat-nav-user-plan">Pro Plan</span>
          </div>
        </Link>
      </div>
    </div>
  )
}
