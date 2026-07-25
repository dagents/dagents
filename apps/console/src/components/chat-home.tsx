'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import '@/styles/chat-home.css'
import { ChatSidebar } from '@/components/chat-sidebar'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { createChat, createMessage } from '@/lib/chats'

export function ChatHome(): React.ReactElement {
  const router = useRouter()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [directories, setDirectories] = useState<Directory[]>([])
  const [loadingDirs, setLoadingDirs] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingDirs(true)
      try {
        const items = await fetchDirectories()
        if (cancelled) return
        setDirectories(items)
        if (items.length > 0) setSelectedDirId(items[0]!.id)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingDirs(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const focusComposer = () => {
    textareaRef.current?.focus()
  }

  const handleSend = async () => {
    if (!input.trim()) return
    const directoryId = selectedDirId
    if (!directoryId) {
      setError('No directory selected')
      return
    }
    setSending(true)
    setError(null)
    try {
      const chat = await createChat({
        directoryId,
        title: input.slice(0, 50),
      })
      await createMessage(chat.id, {
        content: input.trim(),
        role: 'user',
      })
      router.push(`/chats/${chat.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="chat-home-layout">
      <div className="chat-home-sidebar">
        <ChatSidebar
          onSelectChat={(id) => router.push(`/chats/${id}`)}
          onNewChat={focusComposer}
        />
      </div>
      <div className="chat-home-main">
        <div className="chat-home-welcome">
          <h1 className="chat-home-title">开始新对话</h1>
          <p className="chat-home-subtitle">选择项目目录并输入你的问题</p>

          <div className="chat-home-dir-select">
            {loadingDirs ? (
              <div className="muted">Loading directories…</div>
            ) : directories.length === 0 ? (
              <div className="muted">No directories available</div>
            ) : (
              <select
                value={selectedDirId ?? ''}
                onChange={(e) => setSelectedDirId(e.target.value || null)}
                className="select"
              >
                {directories.map((dir) => (
                  <option key={dir.id} value={dir.id}>
                    {dir.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="chat-home-composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入你的问题…"
              className="chat-home-textarea textarea"
              disabled={sending || !selectedDirId}
            />
            <div className="chat-home-actions">
              {error && <span className="muted" style={{ color: 'var(--danger)' }}>{error}</span>}
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSend}
                disabled={sending || !input.trim() || !selectedDirId}
              >
                {sending ? '发送中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
