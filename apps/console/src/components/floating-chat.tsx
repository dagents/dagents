'use client'

/**
 * FloatingChat — multica-style floating chat overlay.
 *
 * Two parts:
 *   1. ChatFab: round button pinned to the bottom-right corner. Click to
 *      open the chat window. Hidden on /chats/[id] (the full-page chat
 *      owns the conversation there) and hidden while the window is open.
 *   2. ChatWindow: a 380×560 panel anchored above the FAB. Contains a
 *      header (directory + close), a message list, and a composer. All
 *      inbound assistant tokens arrive via WebSocket (`useWsChat`) — the
 *      HTTP POST /chats/:id/messages returns immediately with mode='json'
 *      once the gateway's InlineAgentExecutor has spawned claude.
 *
 * State machine:
 *   - activeChatId == null → composer-only "new chat" state. The first
 *     send creates a chat row + writes the user message, then subscribes
 *     to its WS channel for the assistant reply.
 *   - activeChatId != null → live conversation. Subsequent sends append
 *     to the same chat; WS frames patch the trailing assistant bubble.
 *
 * Why WS over SSE here: multica's design has the floating window live
 * across route changes (it's mounted in the dashboard layout), so a
 * per-message SSE connection would tear down on every navigation. The
 * WS hub keeps the channel open for the lifetime of the chat, regardless
 * of which page the user is on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Icon } from '@/components/icon'
import { ChatComposer } from '@/components/chat-composer'
import { DirectorySelector } from '@/components/directory-selector'
import { AssistantContent, extractMeta, type AssistantMessageMeta } from '@/components/assistant-content'
import {
  createChat,
  createMessage,
  fetchMessages,
} from '@/lib/chats'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { useWsChat } from '@/lib/use-ws-chat'
import '@/styles/floating-chat.css'
import '@/styles/assistant-content.css'

/** Rendered message row (optimistic + persisted + streaming-assistant). */
interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  /** True while the assistant bubble is still accumulating WS chunks. */
  streaming?: boolean
  /** True if this is a local-only optimistic bubble (not yet persisted). */
  optimistic?: boolean
  /** Run telemetry for the usage footer (tokens / duration / cost). */
  meta?: AssistantMessageMeta
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function FloatingChat(): React.ReactElement {
  const pathname = usePathname() ?? '/'

  // ─── Window open/close state ───
  // Persisted to localStorage so a reload keeps the user's preference.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const stored = localStorage.getItem('od:floating-chat-open')
    if (stored === '1') setOpen(true)
  }, [])
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      localStorage.setItem('od:floating-chat-open', next ? '1' : '0')
      return next
    })
  }, [])

  // Hide on /chats/[id] — the full-page chat owns the conversation there.
  // Also hide on / (chat home) — that page already has its own composer, so
  // the floating FAB would only overlap the home send button.
  // Also hide on management modules (Agent/Flow/Daemon/Directory/Settings):
  // those pages have no "chat now" mental model; the FAB only obscures
  // detail panels, action buttons and list rows there.
  const onChatDetail = pathname.startsWith('/chats/')
  const onChatHome = pathname === '/'
  const onManagementPage =
    pathname.startsWith('/agents') ||
    pathname.startsWith('/flows') ||
    pathname.startsWith('/workflows') ||
    pathname.startsWith('/daemons') ||
    pathname.startsWith('/settings')
  const shouldHide = onChatDetail || onChatHome || onManagementPage

  return (
    <>
      {open && !shouldHide ? <FloatingChatWindow onClose={() => setOpen(false)} /> : null}
      {!open && !shouldHide ? <ChatFab onClick={toggleOpen} /> : null}
    </>
  )
}

/** Floating action button — round, bottom-right, opens the chat window. */
function ChatFab({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      className="floating-chat-fab"
      onClick={onClick}
      aria-label="打开聊天"
      title="打开聊天"
    >
      <Icon name="chat" style={{ width: 22, height: 22 }} />
    </button>
  )
}

interface FloatingChatWindowProps {
  onClose: () => void
}

function FloatingChatWindow({ onClose }: FloatingChatWindowProps): React.ReactElement {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMessages, setLoadingMessages] = useState(false)

  // We don't track the streaming bubble by id/ref — that requires a side
  // effect inside the setMessages updater, which React 18 StrictMode
  // double-invokes in dev, corrupting the result. Instead we find the
  // streaming bubble by its `streaming: true` flag each time (pure +
  // idempotent — safe to call twice).
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Set true by handleSend right before setActiveChatId so the load-on-
  // chatId-change effect knows to skip the fetch (handleSend owns the
  // message list during a send — fetching would clobber the optimistic
  // bubble + in-flight streaming frames, since the user message isn't
  // persisted yet when the effect fires).
  const justCreatedChatRef = useRef(false)

  // Load directory list + remember the user's last pick.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setDirectories(dirs)
        const stored = localStorage.getItem('od:floating-chat-dir')
        if (stored && dirs.some((d) => d.id === stored)) {
          setSelectedDirId(stored)
        } else if (dirs.length > 0) {
          setSelectedDirId(dirs[0]!.id)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Persist directory selection across sessions.
  useEffect(() => {
    if (selectedDirId) localStorage.setItem('od:floating-chat-dir', selectedDirId)
  }, [selectedDirId])

  // Auto-scroll to the latest message on updates.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ─── WebSocket subscription for the active chat ───
  // The hook handles subscribe on mount + unsubscribe on chatId change;
  // we just patch the local message list here. Frames for other chats
  // (e.g. a previous conversation) are filtered out by the hook.
  const handleWsFrame = useCallback((frame: import('@dagents/contracts').ChatWsFrame) => {
    if (frame.type === 'chat:message') {
      // Append to or create the streaming assistant bubble. Pure updater —
      // safe under React 18 StrictMode double-invoke (no ref writes inside).
      setMessages((prev) => {
        const existing = prev.find((m) => m.streaming)
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id ? { ...m, content: m.content + frame.content } : m,
          )
        }
        return [
          ...prev,
          {
            id: `stream-${Date.now()}`,
            role: 'assistant',
            content: frame.content,
            createdAt: new Date().toISOString(),
            streaming: true,
          },
        ]
      })
      setSending(false) // WS chunk arrived → request succeeded, hide "sending"
    } else if (frame.type === 'chat:done') {
      // Seal the streaming bubble (or append a complete message if no chunk
      // arrived before the executor finished). Carry the run's telemetry
      // (tokens / duration / cost) so the usage footer can render.
      const doneMeta: AssistantMessageMeta | undefined =
        frame.usage || frame.durationMs != null || frame.cost != null
          ? {
              usage: frame.usage
                ? {
                    inputTokens: frame.usage.inputTokens,
                    outputTokens: frame.usage.outputTokens,
                    cacheReadTokens: frame.usage.cacheReadTokens,
                    cacheWriteTokens: frame.usage.cacheWriteTokens,
                  }
                : undefined,
              durationMs: frame.durationMs,
              cost: frame.cost,
            }
          : undefined
      setMessages((prev) => {
        const existing = prev.find((m) => m.streaming)
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id
              ? { ...m, content: frame.content || m.content, streaming: false, meta: doneMeta }
              : m,
          )
        }
        return [
          ...prev,
          {
            id: `done-${Date.now()}`,
            role: 'assistant',
            content: frame.content,
            createdAt: new Date().toISOString(),
            meta: doneMeta,
          },
        ]
      })
      setSending(false)
    } else if (frame.type === 'chat:error') {
      setMessages((prev) => {
        const existing = prev.find((m) => m.streaming)
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id
              ? { ...m, content: frame.content || m.content, streaming: false }
              : m,
          )
        }
        return [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: frame.content,
            createdAt: new Date().toISOString(),
          },
        ]
      })
      setError(frame.error ?? frame.content)
      setSending(false)
    }
  }, [])

  const { connected } = useWsChat(activeChatId, handleWsFrame)

  // ─── Send handler ───
  // Creates a chat on first send, writes the user message, and lets the
  // gateway's InlineAgentExecutor push the reply via WS. The HTTP response
  // returns immediately (mode='json') so we don't block on a stream.
  const handleSend = useCallback(async (text: string) => {
    if (sending) return
    const directoryId = selectedDirId ?? directories[0]?.id
    if (!directoryId) {
      setError('请先选择项目目录')
      return
    }
    setSending(true)
    setError(null)

    // Optimistic user bubble — gives instant feedback before the HTTP
    // roundtrip completes.
    const optimisticId = `opt-${Date.now()}`
    const optimisticMsg: DisplayMessage = {
      id: optimisticId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      optimistic: true,
    }
    setMessages((prev) => [...prev, optimisticMsg])

    try {
      let chatId = activeChatId
      if (!chatId) {
        // First message in this floating session → create the chat row.
        const chat = await createChat({
          directoryId,
          title: text.slice(0, 50),
          ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
        })
        chatId = chat.id
        // Tell the load-on-chatId effect to skip — we own the message list
        // during this send (optimistic bubble + WS frames).
        justCreatedChatRef.current = true
        setActiveChatId(chatId)
      }

      // Write the user message + trigger routing. The gateway's
      // routeMessage sees agentId and spawns the inline executor.
      const result = await createMessage(chatId, {
        content: text,
        role: 'user',
        ...(selectedAgentId ? { agentIdOverride: selectedAgentId } : {}),
      })

      // Replace optimistic bubble with the persisted row.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId
            ? {
                id: result.id,
                role: 'user',
                content: result.content,
                createdAt: result.createdAt,
              }
            : m,
        ),
      )

      // Note: we do NOT clear `sending` here — the assistant bubble is
      // still pending. The first WS chunk (or chat:done / chat:error)
      // clears it. Safety: always arm a fallback timeout so the user is
      // never permanently locked (e.g. no agent selected → executor
      // never runs → no WS frames → sending stuck forever).
      setTimeout(() => setSending(false), 30000)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[floating-chat] handleSend error', err)
      setError(err instanceof Error ? err.message : String(err))
      setSending(false)
      // Roll back the optimistic bubble.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
    }
  }, [sending, selectedDirId, directories, selectedAgentId, activeChatId])

  // ─── New chat (reset) ───
  const handleNewChat = useCallback(() => {
    setActiveChatId(null)
    setMessages([])
    setError(null)
  }, [])

  // ─── Load messages when activeChatId changes (e.g. restored from storage) ───
  // Currently we don't restore activeChatId across reloads (each new
  // floating session starts fresh), but this effect is here for when we do.
  useEffect(() => {
    if (!activeChatId) {
      setMessages([])
      return
    }
    // handleSend just created this chat and owns the message list (optimistic
    // bubble + WS streaming frames). Skip the fetch — it would return before
    // the user message is persisted and clobber the local state with [].
    if (justCreatedChatRef.current) {
      justCreatedChatRef.current = false
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    void (async () => {
      try {
        const msgs = await fetchMessages(activeChatId)
        if (cancelled) return
        setMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            createdAt: m.createdAt,
            meta: extractMeta(m.metadata),
          })),
        )
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingMessages(false)
      }
    })()
    return () => { cancelled = true }
  }, [activeChatId])

  return (
    <div className="floating-chat-window" role="dialog" aria-label="聊天">
      {/* Header — directory selector + new chat + close */}
      <div className="floating-chat-header">
        <div className="floating-chat-header-left">
          <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
        </div>
        <div className="floating-chat-header-right">
          <button
            type="button"
            className="floating-chat-header-btn"
            onClick={handleNewChat}
            aria-label="新对话"
            title="新对话"
          >
            <Icon name="plus" style={{ width: 16, height: 16 }} />
          </button>
          <button
            type="button"
            className="floating-chat-header-btn"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <Icon name="close" style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>

      {/* Connection indicator — dimmed pill when WS is down. */}
      {!connected ? (
        <div className="floating-chat-conn-warning" title="实时连接断开，回退到轮询">
          实时连接断开
        </div>
      ) : null}

      {/* Messages */}
      <div className="floating-chat-messages">
        {messages.length === 0 && !loadingMessages ? (
          <div className="floating-chat-empty">
            <div className="floating-chat-empty-icon">
              <Icon name="bot" style={{ width: 28, height: 28, color: 'var(--accent)' }} />
            </div>
            <div className="floating-chat-empty-title">开始一段对话</div>
            <div className="floating-chat-empty-desc">
              选择目录与 Agent，发送消息即可触发任务
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`floating-chat-msg floating-chat-msg-${m.role}${m.role === 'assistant' ? ' floating-chat-msg-flat' : ''}`}
            >
              {m.role === 'assistant' ? (
                <AssistantContent content={m.content} streaming={m.streaming} meta={m.meta} />
              ) : (
                <div className="floating-chat-msg-content">
                  {m.content}
                  {m.streaming ? <span className="floating-chat-cursor">▋</span> : null}
                </div>
              )}
              {m.role !== 'system' ? (
                <div className="floating-chat-msg-meta">{formatTime(m.createdAt)}</div>
              ) : null}
            </div>
          ))
        )}
        {loadingMessages ? (
          <div className="floating-chat-empty">加载历史消息…</div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      {/* Error toast */}
      {error ? <div className="floating-chat-error">{error}</div> : null}

      {/* Composer */}
      <ChatComposer
        onSend={handleSend}
        disabled={sending}
        agentId={selectedAgentId}
        onAgentChange={setSelectedAgentId}
        placeholder={sending ? 'Agent 执行中…' : '发送消息给 Agent…'}
      />
    </div>
  )
}
