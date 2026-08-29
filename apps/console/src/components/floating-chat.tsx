'use client'

/**
 * FloatingChat —— 全局悬浮副驾（PRD F3，docs/prd-workflow-first.md）。
 *
 * Workflow-First IA 下的 Chat 形态：右下角 FAB + 窗口，**除 /chats/[id]
 * （聊天本体页）外全路由常驻**。执行核心来自 useChatExecution（F0 单一实
 * 现），本组件只管窗口交互：
 *
 *   - 拖动（标题栏）+ 拉大（右下角把手）+ 位置尺寸记忆（D5）
 *   - 画布页避让 React Flow minimap（D5：默认停靠上移）
 *   - 历史抽屉：最近会话列表 + 搜索 + 点入续聊（旧 IA 会话树的承接面）
 *   - 「在详情页打开」→ /chats/[id] 看长回复
 *   - @workflow 生成 done → toast + 「去画布」直达（F7 落点）
 *
 * 旧 IA（dagents.ia.workflow-first=off）保持旧行为：管理页隐藏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { ChatComposer } from '@/components/chat-composer'
import { DirectorySelector } from '@/components/directory-selector'
import { AssistantContent } from '@/components/assistant-content'
import { fetchChats, type Chat } from '@/lib/chats'
import { fetchDirectories, type Directory } from '@/lib/directories'
import { formatClock } from '@/lib/format'
import {
  useChatExecution,
  extractCanvasLink,
} from '@/lib/use-chat-execution'
import { isWorkflowFirstIA } from '@/lib/ia-flag'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import '@/styles/floating-chat.css'

const POS_KEY = 'dagents.fab-chat'

interface WindowPos {
  x: number
  y: number
  w: number
  h: number
}

const DEFAULT_POS: WindowPos = { x: 0, y: 0, w: 380, h: 560 }

function readPos(): WindowPos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return DEFAULT_POS
    const p = JSON.parse(raw) as Partial<WindowPos>
    return {
      x: typeof p.x === 'number' ? p.x : 0,
      y: typeof p.y === 'number' ? p.y : 0,
      w: Math.min(Math.max(p.w ?? 380, 320), 640),
      h: Math.min(Math.max(p.h ?? 560, 420), 860),
    }
  } catch {
    return DEFAULT_POS
  }
}

export function FloatingChat(): React.ReactElement {
  const pathname = usePathname() ?? '/'
  const [wfIA, setWfIA] = useState<boolean | null>(null)
  useEffect(() => {
    setWfIA(isWorkflowFirstIA())
  }, [])

  // 窗口开合记忆
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (localStorage.getItem('od:floating-chat-open') === '1') setOpen(true)
  }, [])
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      localStorage.setItem('od:floating-chat-open', next ? '1' : '0')
      return next
    })
  }, [])

  // 聊天本体页永远隐藏；旧 IA 沿用「管理页隐藏」行为
  const onChatDetail = pathname.startsWith('/chats/')
  const onManagementPage =
    pathname.startsWith('/agents') ||
    pathname.startsWith('/flows') ||
    pathname.startsWith('/workflows') ||
    pathname.startsWith('/daemons') ||
    pathname.startsWith('/settings')
  const shouldHide = wfIA === null ? true : onChatDetail || (wfIA ? false : onManagementPage || pathname === '/')
  // wfIA 为 null（首帧未定）时保守隐藏，避免水合闪烁

  return (
    <>
      {open && !shouldHide ? <FloatingChatWindow onClose={toggleOpen} /> : null}
      {!open && !shouldHide ? <ChatFab onClick={toggleOpen} /> : null}
    </>
  )
}

/** FAB —— 画布页避让 minimap（D5）。 */
function ChatFab({ onClick }: { onClick: () => void }): React.ReactElement {
  const { t } = useI18n()
  const pathname = usePathname() ?? '/'
  const onCanvas = pathname.startsWith('/workflows/')
  return (
    <button
      type="button"
      className={`floating-chat-fab${onCanvas ? ' fab-canvas-offset' : ''}`}
      onClick={onClick}
      aria-label={t('打开聊天')}
      title={t('打开聊天')}
    >
      <Icon name="chat" style={{ width: 22, height: 22 }} />
    </button>
  )
}

interface FloatingChatWindowProps {
  onClose: () => void
}

function FloatingChatWindow({ onClose }: FloatingChatWindowProps): React.ReactElement {
  const { t } = useI18n()
  const toast = useToast()
  const router = useRouter()
  const [directories, setDirectories] = useState<Directory[]>([])
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerChats, setDrawerChats] = useState<Chat[]>([])
  const [drawerQuery, setDrawerQuery] = useState('')
  const [pos, setPos] = useState<WindowPos>(DEFAULT_POS)
  const windowRef = useRef<HTMLDivElement>(null)

  // ─── 窗口几何：位置/尺寸记忆（D5）───
  useEffect(() => {
    setPos(readPos())
  }, [])
  const persistPos = useCallback((p: WindowPos) => {
    localStorage.setItem(POS_KEY, JSON.stringify(p))
  }, [])

  // 拖动（标题栏 pointer 事件）
  const dragStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return // 按钮不拖
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: pos.x,
        baseY: pos.y,
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [pos.x, pos.y],
  )
  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragStateRef.current
      if (!d) return
      const el = windowRef.current
      const w = el?.offsetWidth ?? pos.w
      const maxX = window.innerWidth - w - 8
      const maxY = window.innerHeight - 60
      setPos((p) => ({
        ...p,
        x: Math.min(0, Math.max(maxX, d.baseX + e.clientX - d.startX)),
        y: Math.min(0, Math.max(maxY, d.baseY + e.clientY - d.startY)),
      }))
    },
    [pos.w],
  )
  const onHeaderPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (dragStateRef.current) {
        dragStateRef.current = null
        persistPos(pos)
      }
      const target = e.currentTarget as HTMLElement
      target.releasePointerCapture?.(e.pointerId)
    },
    [persistPos, pos],
  )

  // 拉大（右下角把手）
  const resizeStateRef = useRef<{ startX: number; startY: number; baseW: number; baseH: number } | null>(null)
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      resizeStateRef.current = { startX: e.clientX, startY: e.clientY, baseW: pos.w, baseH: pos.h }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [pos.w, pos.h],
  )
  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    const r = resizeStateRef.current
    if (!r) return
    setPos((p) => ({
      ...p,
      w: Math.min(Math.max(r.baseW + e.clientX - r.startX, 320), Math.min(720, window.innerWidth - 24)),
      h: Math.min(Math.max(r.baseH + e.clientY - r.startY, 420), Math.min(880, window.innerHeight - 24)),
    }))
  }, [])
  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (resizeStateRef.current) {
        resizeStateRef.current = null
        persistPos(pos)
      }
      const target = e.currentTarget as HTMLElement
      target.releasePointerCapture?.(e.pointerId)
    },
    [persistPos, pos],
  )

  // ─── 目录加载（发送前置）───
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (cancelled) return
        setDirectories(dirs)
        const stored = localStorage.getItem('od:floating-chat-dir')
        if (stored && dirs.some((d) => d.id === stored)) setSelectedDirId(stored)
        else if (dirs.length > 0) setSelectedDirId(dirs[0]!.id)
      } catch {
        // 目录加载失败 → 首发时 onReject 提示
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (selectedDirId) localStorage.setItem('od:floating-chat-dir', selectedDirId)
  }, [selectedDirId])

  const dirListRef = useRef<Directory[]>([])
  dirListRef.current = directories
  const agentRef = useRef<string | null>(null)
  agentRef.current = selectedAgentId

  // ─── F0：执行核心 ───
  const exec = useChatExecution({
    resolveDirectoryId: () => selectedDirId ?? dirListRef.current[0]?.id,
    resolveAgentId: () => agentRef.current,
    stoppedLabel: t('_(已停止)_'),
    onDone: (content) => {
      // @workflow 生成落点（F7）：done 帧带画布链接 → toast 直达
      const link = extractCanvasLink(content)
      if (link) {
        toast.success(t('工作流已创建'), {
          action: { label: t('去画布'), onClick: () => router.push(link) },
        })
      }
    },
  })

  // 历史抽屉数据（打开时拉各目录第一页合并）
  useEffect(() => {
    if (!drawerOpen) return
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        const pages = await Promise.all(
          dirs.map((d) => fetchChats(d.id).catch(() => [] as Chat[])),
        )
        if (cancelled) return
        setDrawerChats(pages.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)))
      } catch {
        // 静默
      }
    })()
    return () => {
      cancelled = true
    }
  }, [drawerOpen])

  const filteredDrawerChats = drawerQuery.trim()
    ? drawerChats.filter((c) => c.title.toLowerCase().includes(drawerQuery.trim().toLowerCase()))
    : drawerChats

  // Escape：优先关抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawerOpen) setDrawerOpen(false)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, drawerOpen])

  // 自动滚动
  const messagesEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [exec.messages])

  // F6：末条为 human_input 系统消息 = 有挂起中的 HITL
  const lastMsg = exec.messages[exec.messages.length - 1]
  const hitlPending = !!lastMsg?.humanInput

  return (
    <div
      ref={windowRef}
      className="floating-chat-window fab-draggable"
      role="dialog"
      aria-label={t('聊天')}
      style={{ right: -pos.x, bottom: -pos.y, width: pos.w, height: pos.h }}
    >
      {/* 标题栏 —— 拖动把手 + 操作 */}
      <div
        className="floating-chat-header fab-drag-handle"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <div className="floating-chat-header-left">
          <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
        </div>
        <div className="floating-chat-header-right">
          {exec.activeChatId ? (
            <button
              type="button"
              className="floating-chat-header-btn"
              onClick={() => router.push(`/chats/${exec.activeChatId}`)}
              aria-label={t('在详情页打开')}
              title={t('在详情页打开')}
            >
              <Icon name="arrow" style={{ width: 15, height: 15 }} />
            </button>
          ) : null}
          <button
            type="button"
            className="floating-chat-header-btn"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={t('历史对话')}
            title={t('历史对话')}
          >
            <Icon name="menu" style={{ width: 15, height: 15 }} />
          </button>
          <button
            type="button"
            className="floating-chat-header-btn"
            onClick={exec.newChat}
            aria-label={t('新对话')}
            title={t('新对话')}
          >
            <Icon name="plus" style={{ width: 15, height: 15 }} />
          </button>
          <button
            type="button"
            className="floating-chat-header-btn"
            onClick={onClose}
            aria-label={t('关闭')}
            title={t('关闭')}
          >
            <Icon name="close" style={{ width: 15, height: 15 }} />
          </button>
        </div>
      </div>

      {/* 历史抽屉 */}
      {drawerOpen ? (
        <div className="fab-history-drawer" role="list" aria-label={t('历史对话')}>
          <input
            type="search"
            className="fab-history-search"
            placeholder={t('搜索会话…')}
            value={drawerQuery}
            onChange={(e) => setDrawerQuery(e.target.value)}
            aria-label={t('搜索会话…')}
          />
          <div className="fab-history-list">
            {filteredDrawerChats.length === 0 ? (
              <span className="fab-history-empty">{t('没有匹配的会话')}</span>
            ) : (
              filteredDrawerChats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="listitem"
                  className={`fab-history-item${c.id === exec.activeChatId ? ' active' : ''}`}
                  onClick={() => {
                    exec.openChat(c.id)
                    setDrawerOpen(false)
                  }}
                >
                  <span className={`status-dot ${c.status === 'running' ? 'dot-running' : 'dot-done'}`} />
                  <span className="fab-history-title">{c.title}</span>
                  <span className="fab-history-time">{formatClock(c.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {!exec.connected ? (
        <div className="floating-chat-conn-warning" title={t('实时连接断开 — 助手回复可能无法实时收到，正在尝试重连…')}>
          {t('实时连接断开')}
        </div>
      ) : null}

      {/* 消息区 */}
      <div className="floating-chat-messages">
        {exec.messages.length === 0 && !exec.loadingMessages ? (
          <div className="floating-chat-empty">
            <div className="floating-chat-empty-icon">
              <Icon name="bot" style={{ width: 28, height: 28, color: 'var(--accent)' }} />
            </div>
            <div className="floating-chat-empty-title">{t('开始一段对话')}</div>
            <div className="floating-chat-empty-desc">
              {t('选择目录与 Agent，发送消息即可触发任务；@workflow 可一句话生成流程')}
            </div>
          </div>
        ) : (
          exec.messages.map((m) => (
            <div
              key={m.id}
              className={`floating-chat-msg floating-chat-msg-${m.role}${m.role === 'assistant' ? ' floating-chat-msg-flat' : ''}`}
            >
              {m.role === 'assistant' ? (
                <AssistantContent content={m.content} streaming={m.streaming} meta={m.meta} />
              ) : (
                <div className="floating-chat-msg-content">{m.content}</div>
              )}
              {m.role !== 'system' ? (
                <div className="floating-chat-msg-meta">{formatClock(m.createdAt)}</div>
              ) : null}
            </div>
          ))
        )}
        {exec.loadingMessages ? (
          <div className="floating-chat-empty">{t('加载历史消息…')}</div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      {/* 错误条 */}
      {exec.error ? (
        <div className="floating-chat-error" role="alert">
          <span className="floating-chat-error-text">{exec.error}</span>
          <button
            type="button"
            className="floating-chat-error-close"
            onClick={() => exec.newChat()}
            aria-label={t('关闭错误提示')}
          >
            <Icon name="close" style={{ width: 10, height: 10 }} />
          </button>
        </div>
      ) : null}

      {/* HITL 内联应答条（F6）：末条为 human_input 系统消息 = 流程在等输入。
       * 应答 = 直接在下方输入框发送（exec.send → 消息端点，与聊天详情页
       * 同一通道，ack 路由语义唯一）。 */}
      {hitlPending && !exec.sending ? (
        <div className="fab-hitl-bar" role="status">
          <span className="fab-hitl-label">⏸ {t('流程在等待你的输入 — 在下方输入并发送即可继续')}</span>
        </div>
      ) : null}

      <ChatComposer
        onSend={exec.send}
        onStop={exec.stop}
        stopping={exec.sending}
        agentId={selectedAgentId}
        onAgentChange={setSelectedAgentId}
        placeholder={exec.sending ? t('Agent 执行中…') : t('发送消息给 Agent…')}
      />

      {/* 拉大把手（D5） */}
      <div
        className="fab-resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        aria-label={t('调整窗口大小')}
      />
    </div>
  )
}
