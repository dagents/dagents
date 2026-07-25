'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChatSidebar } from '@/components/chat-sidebar'
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  createMessage,
} from '@/lib/chats'
import '@/styles/chat-detail.css'

interface ChatDetailProps {
  chatId: string
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const STATUS_LABEL: Record<Chat['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
}

export function ChatDetail({ chatId }: ChatDetailProps): React.ReactElement {
  const router = useRouter()
  const [chat, setChat] = useState<Chat | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingChat, setLoadingChat] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingChat(true)
    setLoadingMessages(true)
    setError(null)
    setChat(null)
    setMessages([])

    const ac = new AbortController()

    Promise.all([
      fetchChat(chatId, ac.signal).then((c) => {
        if (!cancelled) {
          setChat(c)
          setLoadingChat(false)
        }
      }),
      fetchMessages(chatId, ac.signal).then((m) => {
        if (!cancelled) {
          setMessages(m)
          setLoadingMessages(false)
        }
      }),
    ]).catch((err: unknown) => {
      if (cancelled) return
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setLoadingChat(false)
      setLoadingMessages(false)
    })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [chatId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSelectChat = useCallback(
    (id: string) => {
      router.push(`/chats/${id}`)
    },
    [router],
  )

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    setSending(true)
    setError(null)

    const optimisticId = `opt-${Date.now()}`
    const optimisticMsg: ChatMessage = {
      id: optimisticId,
      chatId,
      role: 'user',
      content: trimmed,
      runId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    }

    setMessages((prev) => [...prev, optimisticMsg])
    setInput('')

    try {
      const message = await createMessage(chatId, {
        content: trimmed,
        role: 'user',
      })
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? message : m)),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
      setInput(trimmed)
    } finally {
      setSending(false)
    }
  }, [input, sending, chatId])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void sendMessage()
      }
    },
    [sendMessage],
  )

  return (
    <div className="chat-detail-layout">
      <div className="chat-detail-sidebar">
        <ChatSidebar activeChatId={chatId} onSelectChat={handleSelectChat} />
      </div>

      <div className="chat-detail-main">
        <div className="chat-detail-header">
          <div className="chat-detail-title">
            {loadingChat ? 'Loading…' : chat?.title ?? 'Chat'}
          </div>
          {chat && (
            <span className={`status ${chat.status}`}>
              <span className="dot" />
              {STATUS_LABEL[chat.status]}
            </span>
          )}
        </div>

        <div className="chat-detail-messages">
          {loadingChat && loadingMessages ? (
            <div className="muted" style={{ alignSelf: 'center', margin: 'auto' }}>
              Loading chat…
            </div>
          ) : error ? (
            <div
              className="muted"
              style={{
                alignSelf: 'center',
                margin: 'auto',
                color: 'var(--danger)',
              }}
            >
              Failed to load: {error}
            </div>
          ) : messages.length === 0 ? (
            <div className="muted" style={{ alignSelf: 'center', margin: 'auto' }}>
              No messages yet. Send a message to start the conversation.
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
                {m.content}
                <div className="chat-msg-meta">{formatTime(m.createdAt)}</div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-detail-composer">
          <textarea
            className="chat-detail-textarea"
            placeholder="Type a message… Enter to send, Shift+Enter for newline"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending || loadingChat}
          />
          <div className="chat-detail-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void sendMessage()}
              disabled={!input.trim() || sending || loadingChat}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
