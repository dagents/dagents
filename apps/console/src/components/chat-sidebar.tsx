'use client'

import { useEffect, useMemo, useState } from 'react'
import '@/styles/chat-sidebar.css'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { fetchChats, type Chat } from '@/lib/chats'

interface ChatSidebarProps {
  activeChatId?: string | null
  onSelectChat?: (chatId: string) => void
  onNewChat?: () => void
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString()
}

export function ChatSidebar({
  activeChatId,
  onSelectChat,
  onNewChat,
}: ChatSidebarProps): React.ReactElement {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [chats, setChats] = useState<Chat[]>([])
  const [loadingDirs, setLoadingDirs] = useState(true)
  const [loadingChats, setLoadingChats] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingDirs(true)
      setDirError(null)
      try {
        const items = await fetchDirectories()
        if (cancelled) return
        setDirectories(items)
        if (items.length > 0) setSelectedDirId(items[0]!.id)
      } catch (err) {
        if (!cancelled) setDirError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingDirs(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedDirId) {
      setChats([])
      setChatError(null)
      return
    }
    let cancelled = false
    void (async () => {
      setLoadingChats(true)
      setChatError(null)
      try {
        const items = await fetchChats(selectedDirId)
        if (cancelled) return
        const sorted = [...items].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        setChats(sorted)
      } catch (err) {
        if (!cancelled) setChatError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingChats(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedDirId])

  const selectedDir = useMemo(
    () => directories.find((d) => d.id === selectedDirId) ?? null,
    [directories, selectedDirId],
  )

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-dir-select">
        {loadingDirs ? (
          <div className="muted">Loading directories…</div>
        ) : dirError ? (
          <div className="muted">Failed to load directories</div>
        ) : (
          <select
            value={selectedDirId ?? ''}
            onChange={(e) => setSelectedDirId(e.target.value || null)}
            className="chat-sidebar-dir-select-element"
          >
            {directories.map((dir) => (
              <option key={dir.id} value={dir.id}>
                {dir.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="chat-sidebar-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm chat-sidebar-new-btn"
          onClick={onNewChat}
          disabled={!selectedDirId}
        >
          + New chat
        </button>
      </div>

      <div className="chat-sidebar-list">
        {loadingChats ? (
          <div className="muted chat-sidebar-empty">Loading chats…</div>
        ) : chatError ? (
          <div className="muted chat-sidebar-empty">Failed to load chats</div>
        ) : chats.length === 0 ? (
          <div className="muted chat-sidebar-empty">No chats yet</div>
        ) : (
          chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className="chat-sidebar-item"
              aria-selected={activeChatId === chat.id}
              onClick={() => onSelectChat?.(chat.id)}
            >
              <div className="chat-sidebar-item-title">{chat.title}</div>
              {chat.lastMessage && (
                <div className="chat-sidebar-item-preview">{chat.lastMessage}</div>
              )}
              <div className="row-between chat-sidebar-item-meta">
                <span className="mono">{chat.messageCount} msg</span>
                <span className="muted mono">{formatRelativeTime(chat.updatedAt)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
