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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { ChatComposer } from '@/components/chat-composer'
import { ChatContextPanel } from '@/components/chat-context-panel'
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  createMessage,
  updateChat,
} from '@/lib/chats'
import { sendChatMessage } from '@/lib/chat-stream'
import { fetchDirectory, type Directory } from '@/lib/directories'
import '@/styles/chat-detail.css'

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
      const result = await sendChatMessage(chatId, text)

      // Replace optimistic with persisted user message
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId
            ? {
                ...result.userMessage,
                chatId,
                role: 'user',
                runId: null,
                metadata: {},
              }
            : m,
        ),
      )

      if (result.mode === 'stream' && result.events) {
        // Append an empty assistant message we'll fill token-by-token.
        const assistantId = `ast-${Date.now()}`
        setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            chatId,
            role: 'assistant',
            content: '',
            runId: null,
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ])

        let accumulated = ''
        for await (const ev of result.events) {
          if (ev.event === 'token') {
            accumulated += ev.data
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
            )
          } else if (ev.event === 'error') {
            setError(ev.data)
          }
        }

        // Stream ended — mark chat done and persist assistant message
        setChat((prev) => (prev ? { ...prev, status: 'done' } : prev))
        // Persist the assistant message via the existing createMessage API
        // (role='assistant'); the gateway writes it into chat_messages.
        try {
          const persisted = await createMessage(chatId, {
            role: 'assistant',
            content: accumulated,
          })
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? persisted : m)))
        } catch (err) {
          // Persist failed — leave the optimistic assistant message in place.
          console.warn('assistant message persist failed', err)
        }
      } else if (result.mode === 'json') {
        // @-command ack or routing error — system message already written by gateway
        if (result.error) setError(result.error)
        // Refresh chat to reflect any system message + status change
        try {
          const refreshed = await fetchChat(chatId)
          setChat(refreshed)
          const msgs = await fetchMessages(chatId)
          setMessages(msgs)
        } catch {}
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
      setChat((prev) => (prev ? { ...prev, status: 'failed' } : prev))
    } finally {
      setSending(false)
    }
  }, [chatId, sending])

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
              messages.map((m) => (
                <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                  {m.role === 'system' && (
                    <div className="chat-msg-system-icon">
                      <Icon name="zap" style={{ width: 12, height: 12 }} />
                    </div>
                  )}
                  <div className="chat-msg-content">{m.content}</div>
                  {m.role !== 'system' && (
                    <div className="chat-msg-meta">{formatTime(m.createdAt)}</div>
                  )}
                </div>
              ))
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
        <ChatContextPanel chat={chat} directory={directory} messages={messages} />
      </div>
    </div>
  )
}
