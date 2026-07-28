'use client'

/**
 * Chat Detail (/chats/:id) — conversation view.
 *
 * Layout (design-redo paradigm):
 *   - Breadcrumb: 📁 directory / chat title [status]
 *   - Left: message stream + composer
 *   - Right: context panel (directory, agent, flow, stats, runs)
 *
 * The sidebar is global (ChatNavSidebar in ChatLayout) — not rendered here.
 *
 * Realtime: assistant tokens arrive via WebSocket (`useWsChat`). The HTTP
 * POST /chats/:id/messages returns immediately (mode='json') once the
 * gateway's InlineAgentExecutor has spawned claude; we then accumulate
 * chat:message / chat:done / chat:error frames into the trailing assistant
 * bubble. SSE stream mode is no longer used here — the FloatingChat widget
 * shares the same WS hub, so a chat open in both surfaces stays in sync.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { ChatComposer } from '@/components/chat-composer'
import { ChatContextPanel } from '@/components/chat-context-panel'
import { AssistantContent } from '@/components/assistant-content'
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  createMessage,
} from '@/lib/chats'
import { fetchDirectory, type Directory } from '@/lib/directories'
import { useWsChat } from '@/lib/use-ws-chat'
import type { ChatWsFrame } from '@dagents/contracts'
import '@/styles/chat-detail.css'
import '@/styles/assistant-content.css'

interface ChatDetailProps {
  chatId: string
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
}

export function ChatDetail({ chatId }: ChatDetailProps): React.ReactElement {
  const [chat, setChat] = useState<Chat | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(chat?.agentId ?? null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // We identify the streaming assistant bubble by its `stream-` id prefix
  // (persisted messages have UUID ids). This lets the setMessages updater
  // stay pure — no ref writes inside — which is required for React 18
  // StrictMode (dev double-invokes updaters; a ref write inside would
  // corrupt the result on the second invoke).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setChat(null)
    setDirectory(null)
    setMessages([])

    const ac = new AbortController()

    Promise.all([
      fetchChat(chatId, ac.signal).then((c) => {
        if (!cancelled) setChat(c)
        // Fetch directory after chat loads
        return fetchDirectory(c.directoryId, ac.signal).then((d) => {
          if (!cancelled) setDirectory(d)
        }).catch(() => {})
      }),
      fetchMessages(chatId, ac.signal).then((m) => {
        if (!cancelled) setMessages(m)
      }),
    ]).catch((err: unknown) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [chatId])

  // Sync selector with chat's persisted agent when chat loads/changes.
  useEffect(() => {
    if (chat) setSelectedAgentId(chat.agentId)
  }, [chat])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Refresh chat when the context panel edits agent/flow (emits 'chat-updated').
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { chatId: string }
      if (detail.chatId !== chatId) return
      void fetchChat(chatId).then(setChat).catch(() => {})
    }
    window.addEventListener('chat-updated', handler)
    return () => window.removeEventListener('chat-updated', handler)
  }, [chatId])

  // ─── WebSocket subscription for this chat ───
  // Receives chat:message / chat:done / chat:error frames from the gateway's
  // InlineAgentExecutor and patches the trailing assistant bubble.
  const handleWsFrame = useCallback((frame: ChatWsFrame) => {
    if (frame.type === 'chat:message') {
      // Pure updater: find the streaming bubble by `stream-` id prefix.
      // Safe under StrictMode double-invoke (no side effects inside).
      setMessages((prev) => {
        const existing = prev.find((m) => m.id.startsWith('stream-'))
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id ? { ...m, content: m.content + frame.content } : m,
          )
        }
        return [
          ...prev,
          {
            id: `stream-${Date.now()}`,
            chatId,
            role: 'assistant',
            content: frame.content,
            runId: frame.runId ?? null,
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ]
      })
      setSending(false) // first chunk arrived — request succeeded
    } else if (frame.type === 'chat:done') {
      setMessages((prev) => {
        const existing = prev.find((m) => m.id.startsWith('stream-'))
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id ? { ...m, content: frame.content || m.content } : m,
          )
        }
        // No streaming bubble (executor finished before any chunk) — append.
        return [
          ...prev,
          {
            id: `done-${Date.now()}`,
            chatId,
            role: 'assistant',
            content: frame.content,
            runId: frame.runId ?? null,
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ]
      })
      setSending(false)
      setChat((prev) => (prev ? { ...prev, status: 'done' } : prev))
    } else if (frame.type === 'chat:error') {
      setMessages((prev) => {
        const existing = prev.find((m) => m.id.startsWith('stream-'))
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id ? { ...m, content: frame.content || m.content } : m,
          )
        }
        return [
          ...prev,
          {
            id: `err-${Date.now()}`,
            chatId,
            role: 'assistant',
            content: frame.content,
            runId: frame.runId ?? null,
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ]
      })
      setError(frame.error ?? frame.content)
      setSending(false)
      setChat((prev) => (prev ? { ...prev, status: 'failed' } : prev))
    }
  }, [chatId])

  const { connected } = useWsChat(chatId, handleWsFrame)

  const handleSend = useCallback(async (text: string) => {
    if (sending) return
    setSending(true)
    setError(null)

    // Optimistic user message
    const optimisticId = `opt-${Date.now()}`
    const optimisticMsg: ChatMessage = {
      id: optimisticId,
      chatId,
      role: 'user',
      content: text,
      runId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimisticMsg])

    // Mark chat running immediately for breadcrumb + context panel
    setChat((prev) => (prev ? { ...prev, status: 'running' } : prev))

    try {
      // createMessage writes the user row + triggers routeMessage, which
      // (when agentId is set) spawns the InlineAgentExecutor and returns
      // mode='json'. Assistant tokens arrive via WS.
      const persisted = await createMessage(chatId, {
        content: text,
        role: 'user',
        ...(selectedAgentId ? { agentIdOverride: selectedAgentId } : {}),
      })

      // Replace optimistic with persisted user message
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? persisted : m)),
      )

      // If WS is disconnected, the assistant bubble may never arrive via
      // WS. Clear `sending` after a short timeout so the user can retry
      // or navigate. The next WS reconnect will pick up in-flight frames.
      if (!connected) {
        setTimeout(() => setSending(false), 1500)
      }
      // Note: `sending` is cleared on the first WS chunk (or chat:done /
      // chat:error). Don't clear it here — the user should see the
      // "executing…" state while the agent runs.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
      setChat((prev) => (prev ? { ...prev, status: 'failed' } : prev))
      setSending(false)
    }
  }, [chatId, sending, selectedAgentId, connected])

  return (
    <div className="chat-detail-body">
      {/* Breadcrumb */}
      <div className="chat-detail-breadcrumb">
        {directory && (
          <Link href="/directories" className="chat-detail-breadcrumb-dir">
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span>{directory.name}</span>
          </Link>
        )}
        <span className="chat-detail-breadcrumb-sep">/</span>
        <span className="chat-detail-breadcrumb-title">
          {loading ? 'Loading…' : chat?.title ?? 'Chat'}
        </span>
        {chat && (
          <span className={`chat-detail-breadcrumb-status status-${chat.status}`}>
            {STATUS_LABEL[chat.status]}
          </span>
        )}
        {!connected ? (
          <span className="chat-detail-breadcrumb-status status-disconnected" title="实时连接断开">
            实时断开
          </span>
        ) : null}
      </div>

      {/* Main split: messages + context */}
      <div className="chat-detail-split">
        {/* Left: messages + composer */}
        <div className="chat-detail-conversation">
          <div className="chat-detail-messages">
            {loading ? (
              <div className="chat-detail-empty">Loading chat…</div>
            ) : error && messages.length === 0 ? (
              <div className="chat-detail-empty" style={{ color: 'var(--danger)' }}>
                Failed to load: {error}
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-detail-empty">No messages yet. Send a message to start.</div>
            ) : (
              messages.map((m) => {
                const isStreaming = m.id.startsWith('stream-')
                return (
                  <div
                    key={m.id}
                    className={`chat-msg chat-msg-${m.role}${m.role === 'assistant' ? ' chat-msg-flat' : ''}`}
                  >
                    {m.role === 'system' && (
                      <div className="chat-msg-system-icon">
                        <Icon name="zap" style={{ width: 12, height: 12 }} />
                      </div>
                    )}
                    {m.role === 'assistant' ? (
                      <AssistantContent content={m.content} streaming={isStreaming} />
                    ) : (
                      <div className="chat-msg-content">{m.content}</div>
                    )}
                    {m.role !== 'system' && (
                      <div className="chat-msg-meta">{formatTime(m.createdAt)}</div>
                    )}
                  </div>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>
          <ChatComposer
            onSend={handleSend}
            disabled={sending || loading}
            agentId={selectedAgentId}
            onAgentChange={setSelectedAgentId}
          />
        </div>

        {/* Right: context panel */}
        <ChatContextPanel chat={chat} directory={directory} />
      </div>
    </div>
  )
}
