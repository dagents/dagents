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
import { AssistantContent, extractMeta } from '@/components/assistant-content'
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
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  failed: '失败',
}

export function ChatDetail({ chatId }: ChatDetailProps): React.ReactElement {
  const [chat, setChat] = useState<Chat | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(chat?.agentId ?? null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  // Last user text — kept so the retry button can re-send after an error.
  const lastSentTextRef = useRef<string | null>(null)
  // When true, inbound chat:message / chat:done frames are ignored so a
  // stopped run stops patching the trailing bubble. chat:error still lands
  // so the user sees the terminal state.
  const stoppedRef = useRef(false)

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
    setCopiedId(null)
    setShowScrollBtn(false)
    lastSentTextRef.current = null
    stoppedRef.current = false

    // No AbortController here — React 18 StrictMode double-mounts effects in
    // dev (mount → cleanup abort → remount), and the first mount's abort
    // produces ERR_ABORTED console errors for /api/chats/:id and
    // /api/chats/:id/messages. The `cancelled` flag alone is sufficient: it
    // prevents stale state updates from the first (abandoned) mount, and the
    // requests are lightweight enough that cancelling the network call is not
    // worth the console noise.
    Promise.all([
      fetchChat(chatId).then((c) => {
        if (!cancelled) setChat(c)
        // Fetch directory after chat loads
        return fetchDirectory(c.directoryId).then((d) => {
          if (!cancelled) setDirectory(d)
        }).catch(() => {})
      }),
      fetchMessages(chatId).then((m) => {
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
    }
  }, [chatId])

  // Sync selector with chat's persisted agent when chat loads/changes.
  useEffect(() => {
    if (chat) setSelectedAgentId(chat.agentId)
  }, [chat])

  // Auto-scroll to bottom on new messages — but only if the user is already
  // near the bottom. If they've scrolled up to read history, don't yank them
  // down mid-read. The scroll-to-bottom button appears when they're scrolled up.
  const isNearBottom = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  useEffect(() => {
    if (isNearBottom()) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isNearBottom])

  const handleScroll = useCallback(() => {
    setShowScrollBtn(!isNearBottom())
  }, [isNearBottom])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

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
    // If the user stopped the run, ignore further streaming frames — the
    // bubble was already sealed by handleStop with a "(已停止)" marker.
    if (stoppedRef.current && frame.type !== 'chat:error') return
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
      // Carry the run's telemetry (tokens / duration / cost) on the message's
      // metadata so the usage footer renders without a follow-up REST fetch.
      // The gateway's persistComplete already broadcasts these on the WS frame.
      const doneMetadata: Record<string, unknown> = {}
      if (frame.usage) doneMetadata.usage = frame.usage
      if (frame.durationMs != null) doneMetadata.durationMs = frame.durationMs
      if (frame.cost != null) doneMetadata.cost = frame.cost
      setMessages((prev) => {
        const existing = prev.find((m) => m.id.startsWith('stream-'))
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id
              ? { ...m, content: frame.content || m.content, metadata: { ...m.metadata, ...doneMetadata } }
              : m,
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
            metadata: doneMetadata,
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
    // Remember the text so the retry button can re-send on failure, and
    // clear the stopped flag so WS frames flow into the new bubble.
    lastSentTextRef.current = text
    stoppedRef.current = false

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

      // @-commands (@flow / @daemon / @agent) get a system ack written to the
      // DB by the gateway's routeCommand, but no WS frame carries it (WS only
      // streams assistant tokens). Refetch so the ack surfaces in-chat in the
      // same session instead of waiting for the next navigation. Preserve any
      // in-flight streaming assistant bubble that may have arrived via WS.
      if (
        text.startsWith('@flow ') ||
        text.startsWith('@daemon ') ||
        text.startsWith('@agent ')
      ) {
        try {
          const fresh = await fetchMessages(chatId)
          setMessages((prev) => {
            const transient = prev.filter(
              (m) => m.id.startsWith('stream-') || m.id.startsWith('done-'),
            )
            return transient.length ? [...fresh, ...transient] : fresh
          })
        } catch {
          // best-effort — the ack will appear on next navigation
        }
      }

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

  // Stop the in-flight run: seal the streaming bubble with a "(已停止)"
  // marker, clear `sending`, and set the stopped flag so further WS frames
  // are ignored. The backend agent may keep running, but the UI is released.
  const handleStop = useCallback(() => {
    stoppedRef.current = true
    setSending(false)
    setMessages((prev) =>
      prev.map((m) =>
        m.id.startsWith('stream-')
          ? { ...m, content: m.content + '\n\n_(已停止)_' }
          : m,
      ),
    )
    // The stream- id is now a sealed message; rename it so a later run's
    // stream- bubble doesn't collide (and so the stopped bubble stops being
    // treated as the streaming target by handleWsFrame's find).
    setMessages((prev) =>
      prev.map((m) =>
        m.id.startsWith('stream-') ? { ...m, id: `stopped-${Date.now()}` } : m,
      ),
    )
  }, [])

  // Retry the last user message after an error — re-runs handleSend with
  // the stored text and removes the failed assistant bubble.
  const handleRetry = useCallback(() => {
    const text = lastSentTextRef.current
    if (!text) return
    // Drop the failed/error assistant bubble so the retry starts clean.
    setMessages((prev) => prev.filter((m) => !m.id.startsWith('err-') && !m.id.startsWith('stream-')))
    void handleSend(text)
  }, [handleSend])

  // Copy an assistant message's raw content to the clipboard. Shows a
  // transient check mark for 1.5s so the user knows it landed.
  const handleCopy = useCallback(async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    } catch {
      // clipboard may be unavailable (non-secure context) — silent fail
    }
  }, [])

  return (
    <div className="chat-detail-body">
      {/* Breadcrumb */}
      <div className="chat-detail-breadcrumb">
        {directory && (
          <Link href="/directories" className="chat-detail-breadcrumb-dir" title={directory.path}>
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span>{directory.name}</span>
            {directory.path ? (
              <span className="chat-detail-breadcrumb-path">{directory.path}</span>
            ) : null}
          </Link>
        )}
        <span className="chat-detail-breadcrumb-sep">/</span>
        <span className="chat-detail-breadcrumb-title">
          {loading ? '加载中…' : chat?.title ?? '对话'}
        </span>
        {chat && (
          <span className={`chat-detail-breadcrumb-status status-${chat.status}`}>
            {STATUS_LABEL[chat.status]}
          </span>
        )}
      </div>

      {/* WS disconnect banner — elevated from a tiny breadcrumb text to a
          sticky warning bar so a critical connectivity issue isn't missed. */}
      {!connected ? (
        <div className="chat-detail-ws-warning" role="status">
          <Icon name="alertTriangle" style={{ width: 14, height: 14 }} />
          <span>实时连接断开 — 助手回复可能无法实时收到，正在尝试重连…</span>
        </div>
      ) : null}

      {/* Main split: messages + context */}
      <div className="chat-detail-split">
        {/* Left: messages + composer */}
        <div className="chat-detail-conversation">
          <div
            className="chat-detail-messages"
            ref={messagesScrollRef}
            onScroll={handleScroll}
          >
            {loading ? (
              <div className="chat-detail-empty">加载对话…</div>
            ) : error && messages.length === 0 ? (
              <div className="chat-detail-empty" style={{ color: 'var(--danger)' }}>
                加载失败：{error}
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-detail-empty">
                <div className="chat-detail-empty-title">开始对话</div>
                <div className="chat-detail-empty-desc">
                  发送消息，或试试以下建议：
                </div>
                <div className="chat-detail-suggestions" role="group" aria-label="建议提示">
                  {(directory
                    ? [
                        '列出这个目录的文件结构',
                        '解释这个项目的架构',
                        '帮我写一个单元测试',
                        '审查最近的代码变更',
                      ]
                    : [
                        '帮我创建一个批量推理的 AgentFlow',
                        '查看当前 agent 的状态',
                        '解释这段代码的作用',
                        '帮我调试一个错误',
                      ]
                  ).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chat-detail-suggestion-chip"
                      onClick={() => void handleSend(s)}
                      disabled={sending}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                const isStreaming = m.id.startsWith('stream-')
                const isErrorBubble = m.id.startsWith('err-')
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
                      <AssistantContent
                        content={m.content}
                        streaming={isStreaming}
                        meta={extractMeta(m.metadata)}
                      />
                    ) : (
                      <div className="chat-msg-content">{m.content}</div>
                    )}
                    {m.role !== 'system' && (
                      <div className="chat-msg-footer">
                        <span className="chat-msg-meta">{formatTime(m.createdAt)}</span>
                        {m.role === 'assistant' && !isStreaming ? (
                          <button
                            type="button"
                            className="chat-msg-copy"
                            onClick={() => void handleCopy(m.id, m.content)}
                            title="复制"
                            aria-label="复制回复内容"
                          >
                            <Icon name={copiedId === m.id ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
                            <span>{copiedId === m.id ? '已复制' : '复制'}</span>
                          </button>
                        ) : null}
                      </div>
                    )}
                    {isErrorBubble && lastSentTextRef.current ? (
                      <button
                        type="button"
                        className="chat-msg-retry"
                        onClick={handleRetry}
                      >
                        <Icon name="refresh" style={{ width: 12, height: 12 }} />
                        <span>重试</span>
                      </button>
                    ) : null}
                  </div>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>
          {/* Scroll-to-bottom button — appears when the user has scrolled up
              in a long conversation. Floats above the composer. */}
          {showScrollBtn ? (
            <button
              type="button"
              className="chat-detail-scroll-btn"
              onClick={scrollToBottom}
              aria-label="滚动到最新消息"
              title="滚动到最新消息"
            >
              <Icon name="arrowDown" style={{ width: 16, height: 16 }} />
            </button>
          ) : null}
          <ChatComposer
            onSend={handleSend}
            onStop={handleStop}
            stopping={sending}
            disabled={loading}
            autoFocus
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
