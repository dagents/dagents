'use client'

/**
 * Chat view (P1.10.T2 + P1.10.T3).
 *
 * Three-column layout matching design/workspace.html's `.ws-layout`, repurposed
 * as the top-level conversation route:
 *   - left: session list (in-memory for the skeleton; a later task persists)
 *   - center: message stream + composer
 *   - right: run/agent inspector (run id, agent, status, token count)
 *
 * Streaming: the composer sends a message via `streamChat` (→ `/api/chat` →
 * gateway → Flowise with `streaming: true`). The returned async iterator
 * yields `StreamEvent`s; `token` events append to the in-flight assistant
 * message, `metadata` captures the Flowise session/chat id, `error`/`end`
 * close the turn. A blinking cursor marks the streaming message while open.
 *
 * Agent switching (T3): a `<select>` over `CHAT_AGENTS`. Prompt agents drive
 * the prediction API; CLI agents are listed but route through the same path as
 * a placeholder until dispatch lands (flagged in the inspector). Run trigger
 * (T3): the send button (manual); a "重置 run" button clears the run id so the
 * next message starts a fresh trace.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import { streamChat } from '@/lib/chat-client'
import { CHAT_AGENTS, DEFAULT_AGENT, type ChatAgent } from '@/lib/agents'
import type { PredictionMetadata, StreamEvent } from '@/lib/sse'

type Role = 'user' | 'assistant' | 'system'

interface ChatMessage {
  id: string
  role: Role
  content: string
  /** True while the assistant message is still receiving tokens. */
  streaming?: boolean
  error?: string
  thinking?: string
  /** Run id this message belongs to. */
  runId?: string
}

interface ChatSession {
  id: string
  title: string
  preview: string
  createdAt: number
}

/** Seed a couple of empty sessions so the left column isn't blank on load. */
function seedSessions(): ChatSession[] {
  const now = Date.now()
  return [
    { id: 's1', title: '新对话', preview: '开始与 agent 对话…', createdAt: now },
  ]
}

function newId(): string {
  return crypto.randomUUID()
}

export function ChatView(): React.ReactElement {
  const [sessions, setSessions] = useState<ChatSession[]>(() => seedSessions())
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0]!.id)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [agent, setAgent] = useState<ChatAgent>(DEFAULT_AGENT)
  const [runId, setRunId] = useState<string>('')
  const [flowiseSessionId, setFlowiseSessionId] = useState<string>('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [tokenCount, setTokenCount] = useState(0)

  const streamRef = useRef<AsyncGenerator<StreamEvent, void, unknown> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamElRef = useRef<HTMLDivElement>(null)

  // Auto-scroll the message stream to the bottom as tokens arrive.
  useEffect(() => {
    const el = streamElRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    streamRef.current = null
    setIsStreaming(false)
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    )
  }, [])

  const send = useCallback(async () => {
    const question = input.trim()
    if (!question || isStreaming) return

    const userMsg: ChatMessage = { id: newId(), role: 'user', content: question, runId }
    const assistantMsg: ChatMessage = {
      id: newId(),
      role: 'assistant',
      content: '',
      streaming: true,
      runId,
    }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setIsStreaming(true)
    setTokenCount(0)

    // CLI agents aren't wired to the prediction API yet — surface that inline
    // rather than silently hitting Flowise with a non-chatflow id.
    if (agent.runtime === 'cli') {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                streaming: false,
                error: `${agent.label} 是异构 CLI agent，派发经 dispatch 接入（M5b）。当前对话视图暂只支持提示词 agent。`,
              }
            : m,
        ),
      )
      setIsStreaming(false)
      return
    }

    const flowId = agent.flowId
    if (!flowId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, streaming: false, error: '所选 agent 未绑定 chatflow。' }
            : m,
        ),
      )
      setIsStreaming(false)
      return
    }

    // Create the abort controller BEFORE the first await so `stop()` can abort
    // even while we're still waiting on the fetch to connect. Cleared in
    // finally. `stop()` reads `abortRef.current`, so it must be set before any
    // point the user might click stop.
    const ac = new AbortController()
    abortRef.current = ac

    try {
      const { runId: sentRunId, events } = await streamChat({
        flowId,
        question,
        sessionId: flowiseSessionId || undefined,
        runId: runId || undefined,
        signal: ac.signal,
      })
      if (!runId) setRunId(sentRunId)
      streamRef.current = events

      for await (const ev of events) {
        switch (ev.event) {
          case 'token':
            setTokenCount((c) => c + 1)
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, content: m.content + ev.data } : m,
              ),
            )
            break
          case 'thinking':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, thinking: (m.thinking ?? '') + ev.data }
                  : m,
              ),
            )
            break
          case 'metadata': {
            // Prefer sessionId (Flowise Flow State key); fall back to chatId
            // only when sessionId is absent. Use `else if` rather than reading
            // the stale `flowiseSessionId` closure value — within one send()
            // the state hasn't updated, so `!flowiseSessionId` would always be
            // true and a present chatId would overwrite a present sessionId.
            const md = ev.data as PredictionMetadata
            if (md.sessionId) setFlowiseSessionId(md.sessionId)
            else if (md.chatId) setFlowiseSessionId(md.chatId)
            break
          }
          case 'error':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, streaming: false, error: ev.data }
                  : m,
              ),
            )
            break
          case 'end':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, streaming: false } : m,
              ),
            )
            break
          default:
            // sourceDocuments / usedTools / agentReasoning / custom — ignored
            // at the basic chat layer; a richer view can subscribe later.
            break
        }
      }
    } catch (err) {
      // A user-initiated stop aborts the fetch → the reader throws an
      // AbortError. That's not an error to surface: stop() already cleared the
      // streaming flag. Anything else is a real failure.
      const aborted = ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
      if (!aborted) {
        const msg = err instanceof Error ? err.message : String(err)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, streaming: false, error: msg } : m,
          ),
        )
      }
    } finally {
      abortRef.current = null
      streamRef.current = null
      setIsStreaming(false)
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      )
      // Update the active session's preview with the user's question.
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId ? { ...s, preview: question.slice(0, 60) } : s,
        ),
      )
    }
  }, [input, isStreaming, agent, flowiseSessionId, runId, activeSessionId])

  const newSession = useCallback(() => {
    const s: ChatSession = {
      id: newId(),
      title: '新对话',
      preview: '开始与 agent 对话…',
      createdAt: Date.now(),
    }
    setSessions((prev) => [...prev, s])
    setActiveSessionId(s.id)
    setMessages([])
    setRunId('')
    setFlowiseSessionId('')
    setTokenCount(0)
  }, [])

  const resetRun = useCallback(() => {
    setRunId('')
    setFlowiseSessionId('')
    setTokenCount(0)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline. Matches the design's
      // single-line composer intent while allowing multi-line pastes.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send],
  )

  return (
    <PageShell
      title="对话"
      subtitle="经 gateway 调 Flowise，SSE 流式渲染。左侧会话列表，右侧 run/agent 检查器。"
      fullBleed
      actions={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={newSession}>
            + 新会话
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetRun} title="清空 run id，下条消息开启新 trace">
            重置 run
          </button>
        </>
      }
    >
      <div className="chat-layout">
        {/* left: sessions */}
        <div className="chat-sessions">
          <div className="chat-sessions-head">
            <div className="t">
              <span>会话 · {sessions.length}</span>
            </div>
          </div>
          <div className="chat-sessions-body">
            {sessions.map((s) => (
              <div
                key={s.id}
                className="session-item"
                role="button"
                tabIndex={0}
                aria-selected={s.id === activeSessionId}
                onClick={() => {
                  setActiveSessionId(s.id)
                  // Skeleton: each session shares one in-memory message list;
                  // a later task persists per-session history.
                }}
                onKeyDown={(e) => {
                  // role="button" must be activatable from the keyboard
                  // (Enter / Space), not just pointer.
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActiveSessionId(s.id)
                  }
                }}
              >
                <div className="nm">{s.title}</div>
                <div className="mt">{s.preview}</div>
              </div>
            ))}
          </div>
        </div>

        {/* center: chat */}
        <div className="chat-panel">
          <div className="chat-panel-head">
            <div className="title">{agent.label}</div>
            <div className="sub">
              {agent.runtime === 'prompt'
                ? `提示词 agent · flow ${agent.flowId?.slice(0, 8) ?? ''}…`
                : `异构 CLI agent · ${agent.agentType}`}
            </div>
            <div className="filters">
              <div className="agent-select">
                <label htmlFor="agent-select" className="muted" style={{ fontSize: 11 }}>
                  Agent
                </label>
                <select
                  id="agent-select"
                  className="select"
                  value={agent.id}
                  onChange={(e) => {
                    const next = CHAT_AGENTS.find((a) => a.id === e.target.value)
                    if (next) setAgent(next)
                  }}
                >
                  {CHAT_AGENTS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="chat-stream" ref={streamElRef}>
            {messages.length === 0 ? (
              <div className="muted" style={{ alignSelf: 'center', margin: 'auto' }}>
                发送一条消息开始对话。
              </div>
            ) : null}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} agentLabel={agent.label} />
            ))}
          </div>

          <div className="chat-input">
            <div className="chat-input-box">
              <textarea
                rows={1}
                placeholder="输入消息，Enter 发送，Shift+Enter 换行…"
                aria-label="对话消息"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={isStreaming}
              />
              {isStreaming ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={stop}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void send()}
                  disabled={!input.trim()}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>

        {/* right: inspector */}
        <div className="chat-inspector">
          <div className="chat-inspector-head">
            <div className="t" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
              Run 检查器
            </div>
          </div>
          <div className="chat-inspector-body">
            <div className="section-label">当前 run</div>
            <dl className="run-meta">
              <dt>run_id</dt>
              <dd>{runId || '—'}</dd>
              <dt>session</dt>
              <dd>{flowiseSessionId || '—'}</dd>
              <dt>状态</dt>
              <dd>{isStreaming ? 'streaming' : 'idle'}</dd>
              <dt>已收 token</dt>
              <dd>{tokenCount}</dd>
            </dl>

            <div className="section-label mt-6">Agent</div>
            <dl className="run-meta">
              <dt>名称</dt>
              <dd>{agent.label}</dd>
              <dt>类型</dt>
              <dd>{agent.runtime === 'prompt' ? '提示词' : `CLI · ${agent.agentType}`}</dd>
              <dt>flow</dt>
              <dd>{agent.flowId ?? '—'}</dd>
            </dl>
            <p className="muted mt-4" style={{ fontSize: 11 }}>
              {agent.description}
            </p>

            <div className="section-label mt-6">提示</div>
            <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
              对话经 <code className="mono">/api/chat</code> 代理到 gateway
              <code className="mono"> /api/v1/flows/&lt;id&gt;/prediction </code>
              ，<code className="mono">x-run-id</code> 全链路透传，可在 gateway
              与 Langfuse trace 中按此 id 检索。
            </p>
          </div>
        </div>
      </div>
    </PageShell>
  )
}

interface MessageBubbleProps {
  message: ChatMessage
  agentLabel: string
}

function MessageBubble({ message, agentLabel }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user'
  const avatar = isUser ? 'RZ' : 'M'
  const name = isUser ? '你' : agentLabel
  const cls = isUser ? 'msg user' : message.error ? 'msg error' : 'msg'

  return (
    <div className={cls}>
      <div className={`msg-avatar ${isUser ? 'human' : 'bot'}`}>{avatar}</div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{name}</span>
        </div>
        <div className="msg-bubble">
          {message.content}
          {message.streaming ? <span className="cursor" aria-hidden="true" /> : null}
        </div>
        {message.thinking ? <div className="msg-thinking">{message.thinking}</div> : null}
        {message.error ? (
          <div className="msg-thinking" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            {message.error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
