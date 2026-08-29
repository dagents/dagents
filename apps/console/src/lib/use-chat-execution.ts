/**
 * useChatExecution — 聊天执行核心的单一实现（PRD F0，评审 D1）。
 *
 * 此前 floating-chat.tsx 与 chat-detail.tsx 各自维护一份「发消息 → 乐观
 * 气泡 → WS 帧累积 → done/error 收口 → 取消」逻辑，F3 在其上加盖能力等于
 * 制造第三份复制。本 hook 把 WS 路径的执行核心收敛于此：
 *
 *   - 首发自动建会话（createChat + createMessage，目录/Agent 可选）
 *   - WS 帧（chat:message / chat:done / chat:error / chat:cancelled）驱动
 *     乐观气泡 → 流式气泡 → 封口（携带 usage/duration meta）
 *   - 取消（POST /chats/:id/cancel）+ 30s sending 兜底计时器
 *   - 会话切换时自动加载历史消息（fetchMessages）
 *
 * chat-detail 的 flow-SSE 路径不在本 hook 范围（那是 GET /chats/:id/stream
 * 的专属泵）；其 WS 帧拼接可复用导出的纯函数 applyChatFrame。
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatWsFrame } from '@dagents/contracts'
import { createChat, createMessage, fetchMessages } from '@/lib/chats'
import { extractMeta, type AssistantMessageMeta } from '@/components/assistant-content'
import { useWsChat } from '@/lib/use-ws-chat'

/** 消息行（乐观 / 已持久化 / 流式中）。 */
export interface ChatExecutionMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  streaming?: boolean
  optimistic?: boolean
  meta?: AssistantMessageMeta
  /** 历史里的 HumanInput 挂起提示（metadata.type==='human_input'）。 */
  humanInput?: boolean
}

export interface UseChatExecutionOptions {
  /** 发送前的会话目录解析（缺省时 hook 用第一个目录）。 */
  resolveDirectoryId: () => string | undefined
  /** 可选的 Agent 覆盖（发消息时读取）。 */
  resolveAgentId?: () => string | null
  /** 取消按钮的落款文案。 */
  stoppedLabel: string
  /** 发送被拒/失败时的用户提示（目录缺失等）。 */
  onReject?: (message: string) => void
  /** done 帧收口回调（content 为最终全文）——@workflow 直达等消费场景。 */
  onDone?: (content: string) => void
}

export interface ChatExecutionApi {
  activeChatId: string | null
  messages: ChatExecutionMessage[]
  sending: boolean
  error: string | null
  loadingMessages: boolean
  connected: boolean
  send: (text: string) => Promise<boolean>
  stop: () => void
  newChat: () => void
  /** 外部切换会话（历史抽屉点入）——null 清空。 */
  openChat: (chatId: string | null) => void
}

/** WS 帧到消息列表的纯拼接（floating / chat-detail 的公共帧语义）。 */
export function applyChatFrame(
  messages: ChatExecutionMessage[],
  frame: ChatWsFrame,
): ChatExecutionMessage[] {
  if (frame.type === 'chat:message') {
    const existing = messages.find((m) => m.streaming)
    if (existing) {
      return messages.map((m) =>
        m.id === existing.id ? { ...m, content: m.content + frame.content } : m,
      )
    }
    return [
      ...messages,
      {
        id: `stream-${Date.now()}`,
        role: 'assistant',
        content: frame.content,
        createdAt: new Date().toISOString(),
        streaming: true,
      },
    ]
  }
  if (frame.type === 'chat:done') {
    const meta: AssistantMessageMeta | undefined =
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
    const existing = messages.find((m) => m.streaming)
    if (existing) {
      return messages.map((m) =>
        m.id === existing.id
          ? { ...m, content: frame.content || m.content, streaming: false, meta }
          : m,
      )
    }
    return [
      ...messages,
      {
        id: `done-${Date.now()}`,
        role: 'assistant',
        content: frame.content,
        createdAt: new Date().toISOString(),
        meta,
      },
    ]
  }
  if (frame.type === 'chat:error') {
    const existing = messages.find((m) => m.streaming)
    if (existing) {
      return messages.map((m) =>
        m.id === existing.id
          ? { ...m, content: frame.content || m.content, streaming: false }
          : m,
      )
    }
    return [
      ...messages,
      {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: frame.content,
        createdAt: new Date().toISOString(),
      },
    ]
  }
  if (frame.type === 'chat:cancelled') {
    return messages.map((m) =>
      m.streaming
        ? { ...m, content: m.content + '\n\n_(已停止)_', streaming: false }
        : m,
    )
  }
  return messages
}

/** done 帧收口后按帧内容派生提示（@workflow 生成直达等场景可复用）。 */
export function extractCanvasLink(content: string): string | null {
  const m = content.match(/\/workflows\/[0-9a-f-]{36}\/canvas/)
  return m ? m[0] : null
}

export function useChatExecution(opts: UseChatExecutionOptions): ChatExecutionApi {
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatExecutionMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMessages, setLoadingMessages] = useState(false)

  const justCreatedChatRef = useRef(false)
  const fallbackTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(fallbackTimerRef.current), [])

  const optsRef = useRef(opts)
  optsRef.current = opts

  const handleWsFrame = useCallback((frame: ChatWsFrame) => {
    setMessages((prev) => applyChatFrame(prev, frame))
    if (frame.type === 'chat:message' || frame.type === 'chat:done') {
      if (frame.type === 'chat:done') {
        optsRef.current.onDone?.(frame.content || '')
      }
      setSending(false)
    } else if (frame.type === 'chat:error' || frame.type === 'chat:cancelled') {
      if (frame.type === 'chat:error') setError((frame as { error?: string }).error ?? frame.content)
      setSending(false)
    }
  }, [])

  const { connected } = useWsChat(activeChatId, handleWsFrame)

  // 会话切换：加载历史（首发建会话时跳过 —— send 拥有消息列表所有权）。
  useEffect(() => {
    if (!activeChatId) {
      setMessages([])
      return
    }
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
            // HumanInput 挂起提示（F6）：末条为此标记 = 流程在等输入
            humanInput: m.metadata?.type === 'human_input',
          })),
        )
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingMessages(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeChatId])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (sending) return false
      const directoryId = optsRef.current.resolveDirectoryId()
      if (!directoryId) {
        opts.onReject?.('请先选择项目目录')
        setError('请先选择项目目录')
        return false
      }
      const agentId = optsRef.current.resolveAgentId?.() ?? null
      setSending(true)
      setError(null)

      const optimisticId = `opt-${Date.now()}`
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          content: text,
          createdAt: new Date().toISOString(),
          optimistic: true,
        },
      ])

      try {
        let chatId = activeChatId
        if (!chatId) {
          const chat = await createChat({
            directoryId,
            title: text.slice(0, 50),
            ...(agentId ? { agentId } : {}),
          })
          chatId = chat.id
          justCreatedChatRef.current = true
          setActiveChatId(chatId)
        }
        const result = await createMessage(chatId, {
          content: text,
          role: 'user',
          ...(agentId ? { agentIdOverride: agentId } : {}),
        })
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
        window.clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = window.setTimeout(() => setSending(false), 30000)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setSending(false)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
        return false
      }
    },
    // opts 以 ref 化的读取函数为准（调用方保证 getter 稳定或闭包最新值）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sending, activeChatId],
  )

  const stop = useCallback(() => {
    setSending(false)
    if (activeChatId) {
      void fetch(`/api/chats/${activeChatId}/cancel`, { method: 'POST' }).catch(() => {})
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.streaming
          ? { ...m, content: m.content + '\n\n' + opts.stoppedLabel, streaming: false }
          : m,
      ),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId])

  const newChat = useCallback(() => {
    setActiveChatId(null)
    setMessages([])
    setError(null)
  }, [])

  const openChat = useCallback((chatId: string | null) => {
    setActiveChatId(chatId)
    setError(null)
  }, [])

  return {
    activeChatId,
    messages,
    sending,
    error,
    loadingMessages,
    connected,
    send,
    stop,
    newChat,
    openChat,
  }
}
