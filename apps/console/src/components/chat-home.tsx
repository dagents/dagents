'use client'

/**
 * Chat Home (/) — Chat-First landing page.
 *
 * Layout (design-redo paradigm):
 *   - Centered placeholder: bot avatar + welcome + 2×2 suggestion cards
 *   - Bottom: unified composer (agent selector + @ hints + send)
 *
 * No sidebar here — the sidebar is global (ChatNavSidebar in ChatLayout).
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { SuggestionCards } from '@/components/suggestion-cards'
import { ChatComposer } from '@/components/chat-composer'
import { DirectorySelector } from '@/components/directory-selector'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { createChat, createMessage } from '@/lib/chats'
import '@/styles/chat-home.css'

export function ChatHome(): React.ReactElement {
  const router = useRouter()
  const [directories, setDirectories] = useState<Directory[]>([])
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setDirectories(dirs)
        if (dirs.length > 0) setSelectedDirId(dirs[0]!.id)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSend = useCallback(async (text: string) => {
    const directoryId = selectedDirId ?? directories[0]?.id
    if (!directoryId) {
      setError('请先添加项目目录')
      return
    }
    setSending(true)
    setError(null)
    try {
      const chat = await createChat({
        directoryId,
        title: text.slice(0, 50),
      })
      await createMessage(chat.id, { content: text, role: 'user' })
      router.push(`/chats/${chat.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }, [selectedDirId, directories, router])

  return (
    <div className="chat-home-body">
      <div className="chat-home-topbar">
        <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
      </div>
      {/* Placeholder (centered when no active chat) */}
      <div className="chat-home-placeholder">
        <div className="chat-home-placeholder-inner">
          <div className="chat-home-bot-avatar">
            <Icon name="bot" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
          </div>
          <h1 className="chat-home-welcome-title">DAgent Console</h1>
          <p className="chat-home-welcome-desc">
            Multi-agent orchestration with reasoning, tool use, and parallel execution support.
          </p>
          <SuggestionCards onPick={(text) => void handleSend(text)} />
        </div>
      </div>

      {/* Composer */}
      <ChatComposer onSend={handleSend} disabled={sending} />
      {error && (
        <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--text-sm)', paddingBottom: 'var(--space-4)' }}>
          {error}
        </div>
      )}
    </div>
  )
}
