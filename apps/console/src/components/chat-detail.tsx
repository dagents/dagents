'use client'

/**
 * Chat Detail (/chats/:id) — conversation view.
 *
 * Layout (design-redo paradigm):
 *   - Breadcrumb: 📁 directory / chat title [status]
 *   - Center: message stream + composer (agent + flow selectors in composer)
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { ChatComposer } from '@/components/chat-composer'
import { AssistantContent, extractMeta } from '@/components/assistant-content'
import { WorkflowRunCard, AgentSourceBadge } from '@/components/workflow-run-card'
import { ChatDetailSkeleton } from '@/components/skeleton'
import { useToast } from '@/components/toast'
import { useFirstReplyCelebration } from '@/components/use-first-reply-celebration'
import {
  type Chat,
  type ChatMessage,
  fetchChat,
  fetchMessages,
  sendMessageRouted,
  fetchChatRuns,
  type ChatRun,
  updateChat,
  resetChat,
} from '@/lib/chats'
import { subscribeChatStream } from '@/lib/chat-stream'
import { fetchDirectory, type Directory } from '@/lib/directories'
import { useWsChat } from '@/lib/use-ws-chat'
import { useI18n } from '@/i18n'
import { useTaskNotification } from '@/lib/use-task-notification'
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
  const { t } = useI18n()
  const [chat, setChat] = useState<Chat | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  // 工作流执行卡：runId → runs 行（flowName/duration/status）映射 +
  // 当前流式回复是否来自工作流（mode='stream'）+ 流程名兜底映射。
  const [runsInfo, setRunsInfo] = useState<Record<string, ChatRun>>({})
  const [streamIsWorkflow, setStreamIsWorkflow] = useState(false)
  const [flowNameById, setFlowNameById] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(chat?.agentId ?? null)
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(chat?.flowId ?? null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  // Last user text — kept so the retry button can re-send after an error.
  const lastSentTextRef = useRef<string | null>(null)
  // When true, inbound chat:message / chat:done frames are ignored so a
  // stopped run stops patching the trailing bubble. chat:error still lands
  // so the user sees the terminal state.
  const stoppedRef = useRef(false)
  // Retry counter — tracks consecutive failed retries for the same prompt.
  // After MAX_UI_RETRIES consecutive failures, we stop auto-offering retry
  // and instead point the user to the agent config page. Reset to 0 on a
  // successful chat:done or a fresh (non-retry) send.
  const retryCountRef = useRef(0)
  const MAX_UI_RETRIES = 3
  // Set when the user has exhausted retries — the error card switches from
  // "重试" to a "检查 Agent 配置" link. Cleared on the next clean send.
  const [retryExhausted, setRetryExhausted] = useState(false)
  // Brief optimistic "重新连接中…" banner shown while a retry is in flight
  // (between clearing the error bubble and the first chunk arriving).
  const [reconnecting, setReconnecting] = useState(false)

  // First-reply celebration — fire a toast the first time an assistant
  // message appears in this chat. The hook self-guards with localStorage so
  // it only ever fires once per browser.
  const toast = useToast()
  const assistantMessageCount = useMemo(
    () => messages.filter((m) => m.role === 'assistant').length,
    [messages],
  )
  useFirstReplyCelebration(assistantMessageCount, toast.success)

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
    atBottomRef.current = true
    retryCountRef.current = 0
    setRetryExhausted(false)
    setReconnecting(false)

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

  // Sync selectors with chat's persisted agent/flow when chat loads/changes.
  useEffect(() => {
    if (chat) {
      setSelectedAgentId(chat.agentId)
      setSelectedFlowId(chat.flowId)
    }
  }, [chat])

  // ─── Bottom-follow scroll engine (deepseek-harness ChatView pattern) ───
  // "At bottom" is OWNED state that flips only on reader-attributed scrolls:
  // our programmatic writes record their expected scrollTop first so the
  // scroll handler can ignore its own echoes (smooth flights additionally
  // suppress ownership for a short window). Streaming follows with INSTANT
  // scrolls — queued smooth animations would fight each other chunk-to-chunk
  // and read as jank. Threshold 24px: a stray pixel of layout shift doesn't
  // unpin the reader. atBottomRef starts true so a freshly opened long
  // conversation lands at the bottom instead of the top.
  const atBottomRef = useRef(true)
  const programmaticTopRef = useRef<number | null>(null)
  const suppressOwnershipUntilRef = useRef(0)
  const FOLLOW_THRESHOLD = 24

  const followIfPinned = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!atBottomRef.current) return
    const el = messagesScrollRef.current
    if (!el) return
    // scrollTo the exact bottom — anchor-based scrollIntoView would stop
    // one bottom-padding short, permanently past the follow threshold.
    const target = el.scrollHeight - el.clientHeight
    programmaticTopRef.current = target
    if (behavior === 'smooth') suppressOwnershipUntilRef.current = Date.now() + 800
    el.scrollTo({ top: target, behavior })
  }, [])

  // A streaming assistant bubble exists once the first WS chunk lands.
  // Follow new content while pinned — always INSTANT: CSS smooth scrolls
  // are rAF-driven and freeze in background tabs, and queued animations
  // fight each other during rapid chunks. The scroll-to-bottom button is
  // the only place that keeps the animated scroll.
  // useLayoutEffect (not useEffect): a passive effect can be deferred past
  // the commit that renders the loaded messages, leaving a long cold-loaded
  // conversation sitting at the top with ownership still "pinned". The
  // layout effect runs synchronously after the DOM mutation — the correct
  // primitive for a scroll that must land with the content.
  const hasStreamBubble = messages.some((m) => m.id.startsWith('stream-'))
  useLayoutEffect(() => {
    followIfPinned('auto')
  }, [messages, followIfPinned])

  // Last-resort heal (deepseek needs no equivalent — its tabs load visible):
  // a tab that loads while HIDDEN gets its layout computed asynchronously —
  // the layout effect measures empty geometry, RO callbacks never deliver
  // (no rendering steps), and rAF is frozen. A cheap interval still runs in
  // background tabs, so while ownership is pinned it re-checks the gap and
  // follows once real layout exists. Unpinned readers pay one comparison
  // per tick; the interval is idempotent with the streaming follow.
  useLayoutEffect(() => {
    const timer = window.setInterval(() => {
      const box = messagesScrollRef.current
      if (!box || !atBottomRef.current) return
      if (box.scrollHeight - box.scrollTop - box.clientHeight > FOLLOW_THRESHOLD) {
        followIfPinned('auto')
      }
    }, 600)
    return () => window.clearInterval(timer)
  }, [followIfPinned])

  // Content can grow WITHOUT a `messages` change (font swap, a shiki lazy
  // grammar landing, media load) — deepseek-harness follows those with a
  // ResizeObserver on the column. Re-observing also delivers an initial
  // size callback on every messages swap, which heals the case where the
  // follow effect measured before layout was ready (e.g. a backgrounded
  // tab): while we still own the bottom, ANY observed growth re-follows.
  useLayoutEffect(() => {
    const el = messagesScrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const box = messagesScrollRef.current
      if (!box) return
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight
      if (atBottomRef.current || gap < 80) {
        atBottomRef.current = true
        followIfPinned('auto')
      }
    })
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [messages, followIfPinned])

  const handleScroll = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    const expected = programmaticTopRef.current
    if (expected !== null && Math.abs(el.scrollTop - expected) < 2) {
      // Our own write landed — keep the pinned ownership.
      programmaticTopRef.current = null
      atBottomRef.current = true
      setShowScrollBtn(false)
      return
    }
    if (expected !== null && Date.now() < suppressOwnershipUntilRef.current) {
      // A smooth flight still travelling — ignore until it lands or times out.
      return
    }
    programmaticTopRef.current = null
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD
    setShowScrollBtn(!atBottomRef.current)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = messagesScrollRef.current
    if (el) {
      programmaticTopRef.current = el.scrollHeight - el.clientHeight
      suppressOwnershipUntilRef.current = Date.now() + 800
      atBottomRef.current = true
      setShowScrollBtn(false)
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  // ─── Turn status (deepseek-harness TurnStatus) ───
  // The shimmer row occupies the assistant's seat from send to done: while
  // `sending` is true but no bubble exists yet ("正在思考…"), and for the
  // whole run once streaming starts ("正在执行…") so silent tool work never
  // reads as frozen. The elapsed clock stays hidden until 15s so short runs
  // stay quiet.
  const runInProgress = sending || hasStreamBubble
  const [elapsedSec, setElapsedSec] = useState(0)
  useEffect(() => {
    if (!runInProgress) {
      setElapsedSec(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(
      () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [runInProgress])

  // Refresh chat when flow selection is changed via the composer (emits
  // 'chat-updated' after persisting). Keeps breadcrumb status in sync.
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
  /** 拉取 chat 的 runs 映射（执行卡的流程名/耗时/终态来源）。 */
  const loadRuns = useCallback(async (): Promise<void> => {
    try {
      const runs = await fetchChatRuns(chatId)
      setRunsInfo((prev) => {
        const next = { ...prev }
        for (const r of runs) next[r.id] = r
        return next
      })
    } catch {
      // best-effort —— 卡片降级显示 runId
    }
  }, [chatId])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  // 流程名兜底：live 执行卡出现时 runs 行尚未落库（chat 路径终态才写），
  // 拉一次 flows 列表建 id→name 映射，让卡片第一时间显示流程名。
  useEffect(() => {
    if (!chat?.flowId || flowNameById[chat.flowId]) return
    let cancelled = false
    void fetch('/api/workflows', { cache: 'no-store' })
      .then((r) => r.json())
      .then((body: { data?: { flows?: Array<{ id: string; name: string }> } }) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const f of body?.data?.flows ?? []) map[f.id] = f.name
        setFlowNameById((prev) => ({ ...prev, ...map }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.flowId])

  // Receives chat:message / chat:done / chat:error frames from the gateway's
  // InlineAgentExecutor and patches the trailing assistant bubble.
  const handleWsFrame = useCallback((frame: ChatWsFrame) => {
    // If the user stopped the run, ignore further streaming frames — the
    // bubble was already sealed by handleStop with a "(已停止)" marker.
    // chat:cancelled still passes through so the locally-sealed bubble can
    // adopt the gateway's persisted terminal content.
    if (stoppedRef.current && frame.type !== 'chat:error' && frame.type !== 'chat:cancelled') return
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
      // Seal the streaming bubble under a `done-` id (computed outside the
      // updater so it stays pure under StrictMode). handleSend's cleanup
      // only drops `stream-` bubbles — without this rename a COMPLETED
      // live-streamed reply keeps its `stream-` id and vanishes from the
      // UI on the next send (it stays in the DB and only returns on the
      // next full fetch).
      const doneId = `done-${Date.now()}`
      // 工作流执行卡：终态后刷新 runs 映射（流程名/耗时）
      void loadRuns()
      const doneAt = new Date().toISOString()
      setMessages((prev) => {
        const existing = prev.find((m) => m.id.startsWith('stream-'))
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id
              ? { ...m, id: doneId, content: frame.content || m.content, metadata: { ...m.metadata, ...doneMetadata } }
              : m,
          )
        }
        // No streaming bubble (executor finished before any chunk) — append.
        return [
          ...prev,
          {
            id: doneId,
            chatId,
            role: 'assistant',
            content: frame.content,
            runId: frame.runId ?? null,
            metadata: doneMetadata,
            createdAt: doneAt,
          },
        ]
      })
      setSending(false)
      setReconnecting(false)
      // Success — clear the retry counter so the next prompt starts fresh.
      retryCountRef.current = 0
      setRetryExhausted(false)
      setChat((prev) => (prev ? { ...prev, status: 'done' } : prev))
    } else if (frame.type === 'chat:error') {
      setReconnecting(false)
      const errorMessage = frame.error ?? frame.content
      setMessages((prev) => {
        const existing = prev.find((m) => m.id.startsWith('stream-'))
        if (existing) {
          return prev.map((m) =>
            m.id === existing.id
              ? {
                  ...m,
                  content: frame.content || m.content,
                  // Tag the bubble as an error card with a timestamp so the
                  // renderer can show a structured card instead of red text.
                  metadata: { ...m.metadata, isError: true, errorAt: new Date().toISOString(), errorMessage },
                }
              : m,
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
            metadata: { isError: true, errorAt: new Date().toISOString(), errorMessage },
            createdAt: new Date().toISOString(),
          },
        ]
      })
      setError(errorMessage)
      setSending(false)
      setChat((prev) => (prev ? { ...prev, status: 'failed' } : prev))
    } else if (frame.type === 'chat:cancelled') {
      // User-initiated cancel settled on the backend (execution-cancellation
      // spec D6): the CLI child / in-flight fetch was actually stopped and a
      // cancelled assistant message was persisted. Seal the bubble with the
      // gateway's terminal content.
      setSending(false)
      setReconnecting(false)
      setMessages((prev) => {
        const target = prev.find((m) => m.id.startsWith('stream-') || m.id.startsWith('stopped-'))
        if (target) {
          return prev.map((m) =>
            m.id === target.id
              ? {
                  ...m,
                  id: m.id.startsWith('stream-') ? `cancelled-${Date.now()}` : m.id,
                  content: frame.content || m.content,
                  metadata: { ...m.metadata, cancelled: true, reason: frame.reason },
                }
              : m,
          )
        }
        return prev
      })
      setChat((prev) => (prev ? { ...prev, status: 'idle' } : prev))
    }
  }, [chatId, loadRuns])

  // Task-completion notifications: wraps the WS frame handler so terminal
  // events (chat:done / chat:error) fire desktop + sound notifications when
  // the user has tabbed away or is looking at a different chat. The wrapper
  // runs the notifications first, then forwards the frame to handleWsFrame
  // unchanged so the existing in-app behaviour (streaming bubble, usage
  // footer, error card, retry button) is untouched.
  const { wrapHandler: wrapWithNotifications } = useTaskNotification({
    chatId,
    chatTitle: chat?.title,
  })

  const { connected } = useWsChat(chatId, wrapWithNotifications(handleWsFrame))

  // ─── SSE pump for flow-bound chats ───
  // When a send routes to a flow (mode='stream'), the gateway executes it on
  // GET /api/chats/:id/stream and streams metadata → token* → end over SSE
  // (HumanInput parks mid-stream on custom:human_input until the user's next
  // message). This pump translates those frames into the same ChatWsFrame
  // handlers the WebSocket path uses, so flow replies render in the same
  // bubble machinery. A HumanInput ack makes the user's NEXT send return
  // mode='json' (the parked stream resumes) — only mode='stream' opens a new
  // pump, so there is exactly one pump per flow run.
  const pumpChatSse = useCallback(async () => {
    try {
      const events = await subscribeChatStream(chatId)
      // SSE 元数据事件携带本 pump 的 runId —— 工作流执行卡靠它关联
      // node-spans（转换帧时透传给 handleWsFrame）。
      let pumpRunId: string | null = null
      for await (const ev of events) {
        if (stoppedRef.current) return
        if (ev.event === 'metadata') {
          // data 已是解析后的对象（lib/sse 的 StreamEvent.metadata）
          const meta = ev.data as { runId?: string }
          pumpRunId = meta?.runId ?? null
          // 运行一开始就创建直播气泡（空内容 + runId）—— 工作流执行卡靠它
          // 从 t=0 开始轮询点亮节点链。否则首个 token 要等第一个 LLM 节点
          // 跑完才到（CLI 兜底是单发块），live 窗口就没了。
          if (pumpRunId) {
            handleWsFrame({ type: 'chat:message', chatId, role: 'assistant', content: '', streaming: true, runId: pumpRunId })
          }
        } else if (ev.event === 'token') {
          handleWsFrame({ type: 'chat:message', chatId, role: 'assistant', content: ev.data, streaming: true, runId: pumpRunId ?? undefined })
        } else if (ev.event === 'custom' && ev.rawEvent === 'custom:human_input') {
          // The run is PARKED waiting for the user's answer — not busy. Clear
          // `sending` so the composer re-enables and the user can type the
          // answer (their next send returns mode='json' and the parked stream
          // resumes on this same pump).
          setSending(false)
          // The prompt is persisted as a system message server-side — surface
          // it in-chat immediately (same merge the @-command ack path uses).
          try {
            const fresh = await fetchMessages(chatId)
            setMessages((prev) => {
              const transient = prev.filter((m) => m.id.startsWith('stream-') || m.id.startsWith('done-'))
              return transient.length ? [...fresh, ...transient] : fresh
            })
          } catch {
            // best-effort — the system message shows on the next navigation
          }
        } else if (ev.event === 'error') {
          handleWsFrame({ type: 'chat:error', chatId, role: 'assistant', content: '', streaming: false, error: ev.data, runId: pumpRunId ?? undefined })
          return
        } else if (ev.event === 'end') {
          handleWsFrame({ type: 'chat:done', chatId, role: 'assistant', content: '', streaming: false, runId: pumpRunId ?? undefined })
          return
        }
      }
    } catch (err) {
      handleWsFrame({
        type: 'chat:error',
        chatId,
        role: 'assistant',
        content: '',
        streaming: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [chatId, handleWsFrame])

  const handleSend = useCallback(async (text: string) => {
    if (sending) return
    setSending(true)
    setError(null)
    // Remember the text so the retry button can re-send on failure, and
    // clear the stopped flag so WS frames flow into the new bubble.
    lastSentTextRef.current = text
    stoppedRef.current = false
    // A fresh (non-retry) send resets the consecutive-retry counter and
    // drops stale transient bubbles (in-flight `stream-` zombies, `err-`
    // error cards) so the new run starts from a clean slate. Completed
    // replies survive: the chat:done handler renames them to `done-` ids,
    // which this filter keeps.
    retryCountRef.current = 0
    setRetryExhausted(false)
    setReconnecting(false)
    setMessages((prev) =>
      prev.filter((m) => !m.id.startsWith('err-') && !m.id.startsWith('stream-')),
    )

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
      // createMessage writes the user row + triggers routeMessage. For
      // agent-bound chats it returns mode='json' and assistant tokens arrive
      // via WS. For flow-bound chats it returns mode='stream' — the gateway
      // only executes the flow once /api/chats/:id/stream is pulled, so we
      // open that SSE pump and translate frames into the same handlers the
      // WS path uses (without this, flow chats send a message and then wait
      // on WS forever — the flow never runs).
      const routed = await sendMessageRouted(chatId, {
        content: text,
        ...(selectedAgentId ? { agentIdOverride: selectedAgentId } : {}),
      })

      // Replace optimistic with persisted user message
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? routed.message : m)),
      )

      setStreamIsWorkflow(routed.mode === 'stream')
      if (routed.mode === 'stream') {
        void pumpChatSse()
      }

      // @-commands (@flow / @daemon / @agent / @workflow) get a system ack
      // written to the DB by the gateway's routeCommand, but no WS frame
      // carries it (WS only streams assistant tokens). Refetch so the ack
      // surfaces in-chat in the same session instead of waiting for the next
      // navigation. Preserve any in-flight streaming assistant bubble that
      // may have arrived via WS.
      if (
        text.startsWith('@flow ') ||
        text.startsWith('@daemon ') ||
        text.startsWith('@agent ') ||
        text.startsWith('@workflow ')
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

  // Stop the in-flight run: FIRST ask the gateway to actually cancel it
  // (execution-cancellation spec D5/D6 — kills the CLI child / aborts the
  // fetch), then seal the streaming bubble with a "(已停止)" marker locally.
  // The gateway settles with a `chat:cancelled` WS frame whose persisted
  // content replaces the local seal; a 409 means nothing was running, so the
  // local seal is already the correct terminal state.
  const handleStop = useCallback(() => {
    stoppedRef.current = true
    setSending(false)
    void fetch(`/api/chats/${chatId}/cancel`, { method: 'POST' }).catch(() => {
      // Network failure: the local seal stands; the run finishes on its own.
    })
    setMessages((prev) =>
      prev.map((m) =>
        m.id.startsWith('stream-')
          ? { ...m, content: m.content + '\n\n' + t('_(已停止)_') }
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
  }, [t, chatId])

  // Retry the last user message after an error — clears ALL error/failure
  // state (chat status, error bubbles, optimistic stream bubbles), resets
  // the chat to 'idle' on the backend, shows a brief "重新连接中…" banner,
  // then re-sends. After MAX_UI_RETRIES consecutive failures the error card
  // stops offering retry and instead links to /agents so the user can
  // inspect the (likely mis-)configured agent.
  const handleRetry = useCallback(async () => {
    const text = lastSentTextRef.current
    if (!text) return

    // Bump the retry counter and check whether we've exhausted retries.
    retryCountRef.current += 1
    const attempt = retryCountRef.current
    if (attempt > MAX_UI_RETRIES) {
      setRetryExhausted(true)
      toast.error(t('多次失败，请检查 Agent 配置（已重试 {n} 次）', { n: MAX_UI_RETRIES }))
      return
    }

    // Drop ALL error / failed / in-flight assistant bubbles so the retry
    // starts from a clean slate — not just the err- bubble.
    setMessages((prev) =>
      prev.filter(
        (m) =>
          !m.id.startsWith('err-') &&
          !m.id.startsWith('stream-') &&
          !(m.metadata?.isError === true),
      ),
    )
    setError(null)
    setSending(true)
    setReconnecting(true)

    // Reset the chat's backend status to 'idle' before retrying so the
    // gateway's routeMessage doesn't see a stale 'failed' / 'running'
    // status (a 'running' chat would be skipped). Best-effort: if the
    // reset call fails we still attempt the retry below.
    try {
      const reset = await resetChat(chatId)
      setChat(reset)
    } catch (err) {
      console.warn('reset chat before retry failed', err)
    }

    // Clear the optimistic "重新连接中…" banner on a short timer — if the
    // first WS chunk doesn't land quickly, we still want to release the
    // banner so the UI doesn't look stuck. The first chunk / error / done
    // frame also clears it.
    setTimeout(() => setReconnecting(false), 2000)

    // Re-send the stored text via the normal send path. handleSend clears
    // the remaining state and re-spawns the run.
    void handleSend(text)
  }, [chatId, handleSend, toast, t])

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

  // Persist flow selection to the backend when the user changes it via the
  // composer's FlowSelector. Updates local state immediately for snappy UX.
  const handleFlowChange = useCallback(async (flowId: string | null) => {
    setSelectedFlowId(flowId)
    if (!chat) return
    try {
      await updateChat(chat.id, { flowId })
      window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId: chat.id } }))
    } catch (err) {
      console.warn('flow update failed', err)
    }
  }, [chat])

  return (
    <div className="chat-detail-body">
      {/* Breadcrumb — 各部分都有 ellipsis + tooltip，长 title/path 不挤 status */}
      <div className="chat-detail-breadcrumb">
        {directory && (
          <span
            className="chat-detail-breadcrumb-dir"
            title={directory.path ?? directory.name}
          >
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span className="chat-detail-breadcrumb-dir-name">{directory.name}</span>
          </span>
        )}
        {directory && <span className="chat-detail-breadcrumb-sep">/</span>}
        <span
          className="chat-detail-breadcrumb-title"
          title={loading ? undefined : chat?.title}
        >
          {loading ? t('加载中…') : (chat?.title && chat.title.length > 60 ? chat.title.slice(0, 60) + '…' : chat?.title ?? t('对话'))}
        </span>
        {chat && (
          <span className={`chat-detail-breadcrumb-status status-${chat.status}`}>
            {t(STATUS_LABEL[chat.status] ?? chat.status)}
          </span>
        )}
      </div>

      {/* WS disconnect banner — elevated from a tiny breadcrumb text to a
          sticky warning bar so a critical connectivity issue isn't missed. */}
      {!connected ? (
        <div className="chat-detail-ws-warning" role="status">
          <Icon name="alertTriangle" style={{ width: 14, height: 14 }} />
          <span>{t('实时连接断开 — 助手回复可能无法实时收到，正在尝试重连…')}</span>
        </div>
      ) : null}

      {/* Optimistic "重新连接中…" banner — shown briefly between clearing an
          error and the first chunk of a retry landing. Reassures the user the
          retry actually fired (vs. a dead button). Auto-clears on first frame
          or after a 2s safety timeout in handleRetry. */}
      {reconnecting ? (
        <div className="chat-detail-reconnecting" role="status">
          <Icon name="refresh" style={{ width: 14, height: 14 }} />
          <span>{t('重新连接中…')}</span>
        </div>
      ) : null}

      {/* Main: messages + composer (no side panel — flow & agent selectors
          live in the composer's bottom bar) */}
      <div className="chat-detail-conversation">
          <div
            className="chat-detail-messages"
            ref={messagesScrollRef}
            onScroll={handleScroll}
          >
            {loading ? (
              <ChatDetailSkeleton />
            ) : error && messages.length === 0 ? (
              <div className="chat-detail-empty" style={{ color: 'var(--danger)' }}>
                {t('加载失败：{error}', { error })}
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-detail-empty">
                <div className="chat-detail-empty-title">{t('开始对话')}</div>
                <div className="chat-detail-empty-desc">
                  {t('发送消息，或试试以下建议：')}
                </div>
                <div className="chat-detail-suggestions" role="group" aria-label={t('建议提示')}>
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
                      {t(s)}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                const isStreaming = m.id.startsWith('stream-')
                // An error card is either an err- bubble (terminal error) or a
                // stream- bubble that got tagged with isError metadata when
                // chat:error sealed a partially-streamed run.
                const isErrorCard =
                  m.id.startsWith('err-') || m.metadata?.isError === true
                const errorMeta = isErrorCard
                  ? {
                      message: (m.metadata?.errorMessage as string | undefined) ??
                        m.content ??
                        t('未知错误'),
                      at: (m.metadata?.errorAt as string | undefined) ?? m.createdAt,
                    }
                  : null
                return (
                  <div
                    key={m.id}
                    className={`chat-msg chat-msg-${m.role}${m.role === 'assistant' ? ' chat-msg-flat' : ''}`}
                  >
                    {isErrorCard && errorMeta ? (
                      // Structured error card — distinct from a normal
                      // assistant message. Shows the error message, a
                      // timestamp, a primary retry button (or a "check agent
                      // config" link after retries are exhausted), and a
                      // secondary "复制错误信息" action.
                      <div className="chat-error-card" role="alert">
                        <div className="chat-error-card-header">
                          <Icon name="alertTriangle" style={{ width: 16, height: 16 }} />
                          <span className="chat-error-card-title">{t('执行失败')}</span>
                          <span className="chat-error-card-time">{formatTime(errorMeta.at)}</span>
                        </div>
                        <div className="chat-error-card-message">{errorMeta.message}</div>
                        <div className="chat-error-actions">
                          {retryExhausted ? (
                            <Link href="/agents" className="chat-error-link chat-error-link-primary">
                              <Icon name="agents" style={{ width: 12, height: 12 }} />
                              <span>{t('检查 Agent 配置')}</span>
                            </Link>
                          ) : lastSentTextRef.current ? (
                            <button
                              type="button"
                              className="chat-error-retry"
                              onClick={() => void handleRetry()}
                              disabled={sending}
                            >
                              <Icon name="refresh" style={{ width: 12, height: 12 }} />
                              <span>{t('重试')}</span>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="chat-error-link"
                            onClick={() => void handleCopy(`err-copy-${m.id}`, errorMeta.message)}
                          >
                            <Icon name={copiedId === `err-copy-${m.id}` ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
                            <span>{copiedId === `err-copy-${m.id}` ? t('已复制') : t('复制错误信息')}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {m.role === 'system' && (
                          <div className="chat-msg-system-icon">
                            <Icon name="zap" style={{ width: 12, height: 12 }} />
                          </div>
                        )}
                        {m.role === 'assistant' ? (
                          <div className="chat-msg-assistant-wrapper">
                            <div className="chat-msg-avatar" aria-hidden="true">
                              <Icon name="agents" style={{ width: 16, height: 16 }} />
                            </div>
                            {/* Column keeps the footer (time + copy) aligned
                                with the content, not under the avatar. */}
                            <div className="chat-msg-assistant-col">
                              {(() => {
                                // 工作流执行卡：历史消息看 metadata.source；
                                // 本轮直播气泡（stream-/done-）看 mode=stream 标记。
                                const isWf =
                                  m.metadata?.source === 'workflow' ||
                                  (streamIsWorkflow && !!m.runId && (m.id.startsWith('stream-') || m.id.startsWith('done-')))
                                if (isWf && m.runId) {
                                  const run = runsInfo[m.runId]
                                  const fid = run?.flowId ?? chat?.flowId ?? null
                                  const fname = run?.flowName ?? (fid ? flowNameById[fid] : null) ?? null
                                  return (
                                    <WorkflowRunCard
                                      key={`${m.runId}-${m.id.startsWith('stream-') ? 'live' : 'static'}`}
                                      runId={m.runId}
                                      flowName={fname}
                                      flowId={fid}
                                      live={m.id.startsWith('stream-')}
                                      onTerminal={loadRuns}
                                    />
                                  )
                                }
                                if (!isWf) return <AgentSourceBadge />
                                return null
                              })()}
                              <AssistantContent
                                content={m.content}
                                streaming={isStreaming}
                                meta={extractMeta(m.metadata)}
                              />
                              {!isStreaming ? (
                                <div className="chat-msg-footer">
                                  <span className="chat-msg-meta">{formatTime(m.createdAt)}</span>
                                  <button
                                    type="button"
                                    className="chat-msg-copy"
                                    onClick={() => void handleCopy(m.id, m.content)}
                                    title={t('复制')}
                                    aria-label={t('复制回复内容')}
                                  >
                                    <Icon name={copiedId === m.id ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
                                    <span>{copiedId === m.id ? t('已复制') : t('复制')}</span>
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : m.role === 'user' ? (
                          // User message — deepseek-harness pattern: a soft
                          // neutral right-aligned bubble with a hover-revealed
                          // time + copy action row tucked under it.
                          <div className="chat-msg-user-stack">
                            <div className="chat-msg-user-bubble">{m.content}</div>
                            <div className="chat-msg-user-actions">
                              <span className="chat-msg-meta">{formatTime(m.createdAt)}</span>
                              <button
                                type="button"
                                className="chat-msg-copy chat-msg-copy-icon"
                                onClick={() => void handleCopy(m.id, m.content)}
                                title={t('复制')}
                                aria-label={t('复制消息')}
                              >
                                <Icon name={copiedId === m.id ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="chat-msg-content">{m.content}</div>
                        )}
                      </>
                    )}
                  </div>
                )
              })
            )}

            {/* Turn status row (deepseek TurnStatus): shimmer from send to
                done — "正在思考…" before the first chunk, "正在执行…" for the
                rest of the run. Elapsed clock appears after 15s so long
                silent tool work still reads as alive. The avatar renders only
                while NO streaming bubble exists — once one lands, the bubble
                row already carries the assistant avatar, and a second icon
                here read as two simultaneous AI messages. A same-width spacer
                keeps the status text aligned with the bubble's content
                column. */}
            {!loading && runInProgress && messages.length > 0 ? (
              <div className="chat-msg chat-msg-flat assistant-pending-row" role="status" aria-live="polite">
                <div className="chat-msg-assistant-wrapper">
                  {hasStreamBubble ? (
                    <span className="assistant-pending-spacer" aria-hidden="true" />
                  ) : (
                    <div className="chat-msg-avatar" aria-hidden="true">
                      <Icon name="agents" style={{ width: 16, height: 16 }} />
                    </div>
                  )}
                  <div className="assistant-pending">
                    <span className="assistant-pending-text">
                      {hasStreamBubble ? t('正在执行…') : t('正在思考…')}
                    </span>
                    {elapsedSec >= 15 ? (
                      <span className="assistant-pending-clock">{elapsedSec}s</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {/* Scroll-to-bottom — a zero-height sticky slot centered above the
                composer (deepseek toBottomSlot pattern). Sticking inside the
                scroller means the button can never overlap the composer's
                send/stop button, which the old absolutely-positioned variant
                did. */}
            <div className="chat-detail-scroll-slot">
              {showScrollBtn ? (
                <button
                  type="button"
                  className="chat-detail-scroll-btn"
                  onClick={scrollToBottom}
                  aria-label={t('滚动到最新消息')}
                  title={t('滚动到最新消息')}
                >
                  <Icon name="arrowDown" style={{ width: 16, height: 16 }} />
                </button>
              ) : null}
            </div>
          </div>
          <ChatComposer
            onSend={handleSend}
            onStop={handleStop}
            stopping={sending}
            disabled={loading}
            autoFocus
            agentId={selectedAgentId}
            onAgentChange={setSelectedAgentId}
            flowId={selectedFlowId}
            onFlowChange={handleFlowChange}
          />
      </div>
    </div>
  )
}
