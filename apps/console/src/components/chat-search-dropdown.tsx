'use client'

/**
 * ChatSearchResults — inline full-text search results for the sidebar
 * (deepseek-harness search-results tree, ported).
 *
 * While the query is non-empty the sidebar's browser area swaps the
 * directory tree for this panel: compact two-line rows (title heading /
 * directory · content snippet with <mark> highlights), pending / failed /
 * empty states in place, and a refine hint when the result cap is hit.
 * No floating dropdown — the results own the list column exactly like
 * deepseek's WorkspaceBrowser search mode.
 *
 * Keyboard navigation stays driven by the sidebar's search input: it
 * forwards ArrowUp / ArrowDown / Enter here via the imperative handle, so
 * the input keeps focus while rows highlight.
 *
 * The snippet HTML is produced by the gateway with <mark> tags around the
 * hit and HTML-escaped surrounding text, so it is safe to render via
 * dangerouslySetInnerHTML (no other HTML is permitted in the snippet).
 */

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { useRouter } from 'next/navigation'
import { searchChats, type ChatSearchResult } from '@/lib/chats'
import { Icon } from '@/components/icon'
import '@/styles/chat-search.css'
import { useI18n } from '@/i18n'

interface ChatSearchResultsProps {
  /** Current search query (controlled by the sidebar's input). */
  query: string
  /** Called when a result is picked (navigate + clear). */
  onClose: () => void
  /** Optional scope — if set, searches are limited to this directory. */
  directoryId?: string
}

export interface ChatSearchDropdownHandle {
  /** Forward keydown events from the parent input so the panel can react. */
  handleKeyDown: (e: React.KeyboardEvent) => void
}

const DEBOUNCE_MS = 250

/** deepseek's hasMore hint: the gateway caps results; tell the reader the
 *  list is truncated and a tighter query refines it. */
const RESULT_CAP_HINT = 20

export const ChatSearchDropdown = forwardRef<ChatSearchDropdownHandle, ChatSearchResultsProps>(
  function ChatSearchResults(
    { query, onClose, directoryId },
    ref,
  ): React.ReactElement | null {
    const { t } = useI18n()
    const router = useRouter()
    const [results, setResults] = useState<ChatSearchResult[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [activeIndex, setActiveIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    const reqIdRef = useRef(0)

    const trimmed = query.trim()
    const isSearching = trimmed.length > 0

    // Debounced search (deepseek SEARCH_DEBOUNCE_MS = 250). Each new query
    // bumps an internal request id; only the response matching the latest
    // id lands — stale responses are dropped.
    useEffect(() => {
      if (!isSearching) {
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
            setError(t('搜索失败，请重试'))
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
    }, [trimmed, isSearching, directoryId])

    // Clamp activeIndex when the row set shrinks.
    useEffect(() => {
      if (activeIndex >= results.length) {
        setActiveIndex(results.length === 0 ? 0 : results.length - 1)
      }
    }, [results.length, activeIndex])

    // Scroll the active row into view inside the list.
    useEffect(() => {
      if (!listRef.current) return
      const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex])

    const pickRow = useCallback(
      (result: ChatSearchResult) => {
        router.push(`/chats/${result.chatId}`)
        onClose()
      },
      [router, onClose],
    )

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length))
        } else if (e.key === 'Enter') {
          if (results.length > 0) {
            e.preventDefault()
            const row = results[activeIndex] ?? results[0]
            if (row) pickRow(row)
          }
        }
      },
      [results, activeIndex, pickRow],
    )

    // Expose handleKeyDown so the sidebar can forward input keydown events.
    useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown])

    if (!isSearching) return null

    const showEmpty = !loading && !error && results.length === 0

    return (
      <div className="chat-search-results" role="listbox" aria-label={t('搜索结果')}>
        {loading && (
          <div className="chat-search-status" role="status">
            <Icon name="loader" className="chat-search-spinner" style={{ width: 13, height: 13 }} />
            <span>{t('搜索中…')}</span>
          </div>
        )}

        {error && (
          <div className="chat-search-status is-warning" role="status">{error}</div>
        )}

        {showEmpty && (
          <div className="chat-search-status">{t('无匹配结果')}</div>
        )}

        {results.length > 0 && (
          <div className="chat-search-list" ref={listRef}>
            {results.map((r, i) => {
              const isActive = i === activeIndex
              return (
                <button
                  type="button"
                  key={`${r.chatId}-${i}`}
                  data-idx={i}
                  className={`chat-search-item${isActive ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => pickRow(r)}
                  role="option"
                  aria-selected={isActive}
                >
                  {/* Heading: title (deepseek .searchResultHeading — we have no
                      per-result status from the search endpoint, so no slot). */}
                  <span className="chat-search-item-heading">
                    <span className="chat-search-item-title">{r.chatTitle || t('新对话')}</span>
                  </span>
                  {/* Meta line: directory label + content snippet, one line. */}
                  <span className="chat-search-item-meta">
                    <span className="chat-search-item-dir">{r.directoryName}</span>
                    {r.snippet ? (
                      <span
                        className="chat-search-item-snippet"
                        dangerouslySetInnerHTML={{ __html: r.snippet }}
                      />
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {!loading && !error && results.length >= RESULT_CAP_HINT && (
          <div className="chat-search-status">{t('仅显示前 {n} 条，输入更精确的关键词可缩小范围', { n: RESULT_CAP_HINT })}</div>
        )}
      </div>
    )
  },
)
