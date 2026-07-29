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
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { SuggestionCards } from '@/components/suggestion-cards'
import { ChatComposer } from '@/components/chat-composer'
import { DirectorySelector } from '@/components/directory-selector'
import { useDirectories } from './use-directories'
import { createChat, createMessage } from '@/lib/chats'
import { pickDirectory, createDirectory } from '@/lib/directories'
import '@/styles/chat-home.css'

export function ChatHome(): React.ReactElement {
  const router = useRouter()
  const { directories, loading, error, reload } = useDirectories()
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [addingDir, setAddingDir] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    if (directories.length > 0 && !selectedDirId) setSelectedDirId(directories[0]!.id)
  }, [directories, selectedDirId])

  const handleSend = useCallback(async (text: string) => {
    const directoryId = selectedDirId ?? directories[0]?.id
    if (!directoryId) {
      setSendError('请先添加项目目录')
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const chat = await createChat({
        directoryId,
        title: text.slice(0, 50),
        ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
      })
      await createMessage(chat.id, { content: text, role: 'user' })
      router.push(`/chats/${chat.id}`)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }, [selectedDirId, directories, selectedAgentId, router])

  const handleAddDirectory = useCallback(async (): Promise<void> => {
    setAddError(null)
    setAddingDir(true)
    try {
      const path = await pickDirectory()
      if (!path) return // user cancelled the OS dialog
      const dir = await createDirectory({ path })
      // Set selection BEFORE reload so the empty state hides immediately,
      // even if reload() fails (reload swallows errors internally).
      setSelectedDirId(dir.id)
      await reload()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddingDir(false)
    }
  }, [reload])

  return (
    <div className="chat-home-body">
      <div className="chat-home-topbar">
        <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
      </div>
      {directories.length === 0 && !loading && !selectedDirId ? (
        <div className="chat-home-empty">
          <div className="chat-home-empty-icon">
            <Icon name="folder" style={{ width: 48, height: 48, color: 'var(--accent)' }} />
          </div>
          <h2 className="chat-home-empty-title">开始前，请先添加一个项目目录</h2>
          <p className="chat-home-empty-desc">
            DAgent 需要知道在哪里运行 Agent。添加一个本地目录即可开始对话。
          </p>
          <button
            type="button"
            className="chat-home-empty-cta"
            onClick={() => void handleAddDirectory()}
            disabled={addingDir}
          >
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>{addingDir ? '等待选择…' : '浏览本地目录…'}</span>
          </button>
          {addError ? (
            <div className="chat-home-empty-error">{addError}</div>
          ) : null}
          <Link className="chat-home-empty-secondary" href="/directories">
            或前往目录管理页 →
          </Link>
        </div>
      ) : (
        <div className="chat-home-placeholder">
          <div className="chat-home-placeholder-inner">
            <div className="chat-home-bot-avatar">
              <Icon name="bot" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
            </div>
            <h1 className="chat-home-welcome-title">DAgent 控制台</h1>
            <p className="chat-home-welcome-desc">
              多 Agent 编排平台，支持推理、工具调用与并行执行。
            </p>
            <SuggestionCards onPick={(text) => void handleSend(text)} />
          </div>
        </div>
      )}

      {/* Composer */}
      <ChatComposer
        onSend={handleSend}
        disabled={sending || (directories.length === 0 && !selectedDirId)}
        agentId={selectedAgentId}
        onAgentChange={setSelectedAgentId}
        autoFocus
      />
      {(error ?? sendError) && (
        <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--text-sm)', paddingBottom: 'var(--space-4)' }}>
          {error ?? sendError}
        </div>
      )}
    </div>
  )
}
