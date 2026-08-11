'use client'

/**
 * ChatSearchDropdown — full-text search results dropdown for the chat sidebar.
 *
 * Renders below the sidebar search input. When the query is non-empty, it
 * debounces (300ms) and calls searchChats() to hit the gateway's
 * /api/v1/chats/search endpoint, then shows results with <mark>-highlighted
 * snippets.
 *
 * When the query is empty and the dropdown is open (input focused), it shows
 * the recent chat list (passed in by the sidebar) so the dropdown doubles as
 * a quick-jump menu.
 *
 * Keyboard navigation is driven by the parent sidebar, which forwards
 * ArrowUp/ArrowDown/Enter/Escape from the search input to `handleKeyDown`.
 * This keeps the input as the single source of focus while the dropdown
 * visually highlights the active row.
 *
 * The snippet HTML is produced by the gateway with <mark> tags around the hit
 * and HTML-escaped surrounding text, so it is safe to render via
 * dangerouslySetInnerHTML (no other HTML is permitted in the snippet).
 */

import { useEffect, useMemo, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { useRouter } from 'next/navigation'
import { searchChats, type ChatSearchResult, type Chat } from '@/lib/chats'
import { Icon } from '@/components/icon'
import '@/styles/chat-search.css'

interface ChatSearchDropdownProps {
  /** Current search query (controlled by the sidebar's input). */
  query: string
  /** Whether the dropdown should be visible (typically: input is focused). */
  open: boolean
  /** Called when the user dismisses the dropdown (Escape or pick). */
  onClose: () => void
  /** Recent chats to show when the query is empty (quick-jump mode). */
  recentChats: Chat[]
  /** Optional scope — if set, searches are limited to this directory. */
  directoryId?: string
  /** Currently-active chat id, to highlight the active row in recent mode. */
  activeChatId?: string | null
}

export interface ChatSearchDropdownHandle {
  /** Forward keydown events from the parent input so the dropdown can react. */
  handleKeyDown: (e: React.KeyboardEvent) => void
}

const DEBOUNCE_MS = 300

export const ChatSearchDropdown = forwardRef<ChatSearchDropdownHandle, ChatSearchDropdownProps>(
  function ChatSearchDropdown(
    { query, open, onClose, recentChats, directoryId, activeChatId },
    ref,
  ): React.ReactElement | null {
    const router = useRouter()
    const [results, setResults] = useState<ChatSearchResult[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [activeIndex, setActiveIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    const reqIdRef = useRef(0)

    const trimmed = query.trim()
    const isSearching = trimmed.length > 0

    // Debounced search. Each new query bumps an internal request id; only the
    // response matching the latest id lands — stale responses are dropped.
    useEffect(() => {
      if (!open || !isSearching) {
        setResults([])
        setLoading(false)
        setError(null)
        return
      }

      const handle = window.setTimeout(() => {
        const myId = ++reqIdRef.current
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        searchChats(trimmed, directoryId, controller.signal)
          .then((items) => {
            if (reqIdRef.current !== myId) return // stale
            setResults(items)
            setActiveIndex(0)
          })
          .catch((err: unknown) => {
            if (reqIdRef.current !== myId) return
            // AbortError happens when a newer query supersedes this one — not an error.
            if (err instanceof DOMException && err.name === 'AbortError') return
            setError('搜索失败，请重试')
            setResults([])
          })
          .finally(() => {
            if (reqIdRef.current !== myId) return
            setLoading(false)
          })
      }, DEBOUNCE_MS)

      return () => {
        window.clearTimeout(handle)
      }
    }, [trimmed, open, isSearching, directoryId])

    // Build a flat list of "rows" the keyboard can navigate. In search mode
    // these are the search results; in recent mode they're the recent chats.
    type Row =
      | { kind: 'result'; result: ChatSearchResult; href: string }
      | { kind: 'recent'; chat: Chat; href: string }
    const rows: Row[] = useMemo(() => {
      if (isSearching) {
        return results.map((r) => ({ kind: 'result' as const, result: r, href: `/chats/${r.chatId}` }))
      }
      return recentChats.map((c) => ({ kind: 'recent' as const, chat: c, href: `/chats/${c.id}` }))
    }, [isSearching, results, recentChats])

    // Clamp activeIndex when the row set shrinks.
    useEffect(() => {
      if (activeIndex >= rows.length) {
        setActiveIndex(rows.length === 0 ? 0 : rows.length - 1)
      }
    }, [rows.length, activeIndex])

    // Scroll the active row into view inside the list.
    useEffect(() => {
      if (!listRef.current) return
      const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex])

    const pickRow = useCallback(
      (row: Row) => {
        router.push(row.href)
        onClose()
      },
      [router, onClose],
    )

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (!open) return
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length))
        } else if (e.key === 'Enter') {
          if (rows.length > 0) {
            e.preventDefault()
            const row = rows[activeIndex] ?? rows[0]
            if (row) pickRow(row)
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      },
      [open, rows, activeIndex, pickRow, onClose],
    )

    // Expose handleKeyDown so the sidebar can forward input keydown events.
    useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown])

    if (!open) return null

    const showEmpty = isSearching && !loading && !error && results.length === 0
    const showRecent = !isSearching

    return (
      <div
        className={`chat-search-dropdown${loading ? ' is-loading' : ''}`}
        role="listbox"
        aria-label={isSearching ? '搜索结果' : '最近对话'}
      >
        {loading && (
          <div className="chat-search-dropdown-loading">
            <Icon name="loader" className="chat-search-spinner" style={{ width: 14, height: 14 }} />
            <span>搜索中…</span>
          </div>
        )}

        {error && (
          <div className="chat-search-dropdown-error">{error}</div>
        )}

        {showEmpty && (
          <div className="chat-search-dropdown-empty">无结果</div>
        )}

        {showRecent && recentChats.length === 0 && (
          <div className="chat-search-dropdown-empty">暂无对话</div>
        )}

        {rows.length > 0 && (
          <div className="chat-search-dropdown-list" ref={listRef}>
            {showRecent && (
              <div className="chat-search-dropdown-section">最近对话</div>
            )}
            {rows.map((row, i) => {
              const isActive = i === activeIndex
              if (row.kind === 'result') {
                const r = row.result
                return (
                  <button
                    type="button"
                    key={`${r.chatId}-${r.matchType}-${i}`}
                    data-idx={i}
                    className={`chat-search-item${isActive ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => pickRow(row)}
                    role="option"
                    aria-selected={isActive}
                  >
                    <div className="chat-search-item-main">
                      <span className="chat-search-item-title">{r.chatTitle}</span>
                      <span
                        className={`chat-search-item-badge ${r.matchType}`}
                        title={r.matchType === 'title' ? '标题匹配' : '内容匹配'}
                      >
                        {r.matchType === 'title' ? '标题匹配' : '内容匹配'}
                      </span>
                    </div>
                    <p
                      className="chat-search-item-snippet"
                      dangerouslySetInnerHTML={{ __html: r.snippet }}
                    />
                    <div className="chat-search-item-meta">
                      <span className="chat-search-item-dir">{r.directoryName}</span>
                    </div>
                  </button>
                )
              }
              // recent mode
              const c = row.chat
              return (
                <button
                  type="button"
                  key={c.id}
                  data-idx={i}
                  className={`chat-search-item chat-search-item-recent${isActive ? ' is-active' : ''}${activeChatId === c.id ? ' is-current' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => pickRow(row)}
                  role="option"
                  aria-selected={isActive}
                >
                  <div className="chat-search-item-main">
                    <span className={`chat-search-item-status ${c.status}`} />
                    <span className="chat-search-item-title">{c.title || '新对话'}</span>
                  </div>
                  <div className="chat-search-item-meta">
                    <span className="chat-search-item-dir">{c.lastMessage ?? '空对话'}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  },
)
