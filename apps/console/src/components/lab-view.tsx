'use client'

/**
 * Lab 多 agent 聊天室 view (P1.10.T7 / M5b.2).
 *
 * Three-column layout matching design/lab.html's `.lab-layout`:
 *   - left: experiment session list (`/api/lab/sessions`)
 *   - center: threaded chat (`/api/lab/sessions/:id`) + composer with @mention
 *     chips + auto/assist mode switch
 *   - right: artifacts panel — agents who have spoken + tool calls + hypotheses
 *
 * Data flow: this client component fetches the console's own `/api/lab/*` proxy
 * routes (browser → gateway → DB), derives the thread messages + artifact
 * rollups from the pure mappers in `lib/lab.ts`, and renders the design's DOM
 * (ported to React). Page-local styles live in `styles/lab.css`; `shell.css`
 * provides the shared component classes (.btn / .status / .chip / .card-flat /
 * .row-between / .mono / .muted).
 *
 * ## Threading + thinking + tool blocks
 *
 * Each `lab_messages` row carries a `role` (who spoke), an optional `thinking`
 * (the agent's private reasoning, "💭 …") and an optional `toolCall` (`{ name,
 * input, output }`, the "🛠 tool" card). `messagesToThread` precomputes the
 * avatar class / initial / name / role tag / day separator + the parsed
 * @mentions so a bubble renders without re-deriving per frame. The thread
 * reuses the OTel `run_id` (M6.1) so a turn is end-to-end traceable.
 *
 * ## Human intervention (介入模式)
 *
 * The composer posts a `human` turn through the append proxy
 * (`/api/lab/sessions/:id/messages`), threading a client-generated `run_id`
 * into the row. An agent autonomous loop (agents replying to each other) is a
 * dispatch/daemon orchestration concern outside this frontend task; the view
 * renders whatever turns the session holds, human or agent. The auto/assist
 * mode switch PATCHes the session's `mode` (persisted) and toggles the composer
 * hint; "归档会话" PATCHes `status` to `done` (the session then leaves the
 * default running-only left list).
 *
 * Honesty about coverage: "+ 新实验" renders but is a no-op for MVP (the
 * design's full experiment-config modal is post-MVP). "归档会话" is wired to a
 * real PATCH (status → done); resuming an archived session is post-MVP.
 * The right artifacts panel's hypotheses/数据/代码 groups are seeded from the
 * thread's tool calls + agent set, not a separate artifacts table (the spec
 * lists no `lab_artifacts` table — artifacts are produced `runs`, surfaced on
 * the Workspace page).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import '@/styles/lab.css'
import {
  fetchLabSessionDetail,
  fetchLabSessions,
  LAB_MENTION_HANDLES,
  messagesToThread,
  patchLabSession,
  sendLabMessage,
  sessionStatusLabel,
  splitBodyMentions,
  type LabMessage,
  type LabSessionDetail,
  type LabSessionMode,
  type LabSessionSummary,
  type LabThreadMessage,
  type LabToolCall,
} from '@/lib/lab'

export function LabView(): React.ReactElement {
  const [sessions, setSessions] = useState<LabSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LabSessionDetail | null>(null)
  const [thread, setThread] = useState<readonly LabThreadMessage[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [sending, setSending] = useState(false)
  const [composer, setComposer] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  // In-room mode override while a PATCH is in flight (the persisted mode lives
  // on the session row). Cleared on selection so the session's stored mode shows.
  const [modeOverride, setModeOverride] = useState<LabSessionMode | null>(null)

  const streamElRef = useRef<HTMLDivElement>(null)
  // The composer textarea. Auto-grown on every composer change (typing AND
  // @mention insertion) so the box always fits its text — design/lab.html's
  // `input` listener: reset to `auto`, then clamp at the CSS max-height (120).
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the composer to fit its content, capping at the `.chat-input-box
  // textarea` max-height (120px, design/lab.html:64). Fires on every composer
  // change so the box grows while typing and shrinks back when a mention is
  // inserted or the field is cleared after a send.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [composer])

  // Fetch the session list once on mount; auto-select the first so the center
  // + right panels aren't empty on load.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingList(true)
      setListError(null)
      try {
        const items = await fetchLabSessions()
        if (cancelled) return
        setSessions(items)
        if (items.length > 0) setSelectedId(items[0]!.id)
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingList(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch the selected session's detail + thread whenever the selection
  // changes. One call (detail includes the full thread); resets the in-room
  // mode override so the session's persisted mode shows.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      setThread([])
      setThreadError(null)
      return
    }
    let cancelled = false
    void (async () => {
      setLoadingDetail(true)
      setThreadError(null)
      setModeOverride(null)
      try {
        const d = await fetchLabSessionDetail(selectedId)
        if (cancelled) return
        setDetail(d)
        setThread(messagesToThread(d.messages))
      } catch (err) {
        if (!cancelled) setThreadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  // Auto-scroll the thread to the bottom when new messages arrive.
  useEffect(() => {
    const el = streamElRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread, selectedId])

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  )

  const activeMode: LabSessionMode = modeOverride ?? detail?.session.mode ?? 'auto'

  const send = useCallback(async () => {
    const text = composer.trim()
    if (!text || sending || !detail) return
    setSending(true)
    setSendError(null)
    // Generate a client-side run id so the human turn correlates with the
    // OTel trace (M6.1) before the row lands; the gateway also accepts none.
    const runId = crypto.randomUUID()
    // Optimistically append the human turn so the thread feels live; the
    // gateway's next detail fetch reconciles it with the real row.
    const optimistic: LabThreadMessage = {
      key: `local:${runId}`,
      role: 'human',
      avatarClass: 'human',
      initial: 'H',
      name: '你',
      roleTag: '人工介入',
      time: hhmmNow(),
      body: text,
      mentions: [],
      thinking: null,
      toolCall: null,
      runId,
    }
    setThread((prev) => [...prev, optimistic])
    setComposer('')
    try {
      await sendLabMessage({
        sessionId: detail.session.id,
        role: 'human',
        body: text,
        runId,
      })
      // Re-fetch the detail so the real row (with its server id + createdAt)
      // replaces the optimistic one. Best-effort: a fetch failure leaves the
      // optimistic turn visible (the append already succeeded server-side).
      try {
        const d = await fetchLabSessionDetail(detail.session.id)
        setDetail(d)
        setThread(messagesToThread(d.messages))
      } catch {
        // swallow — the append succeeded; the next selection reconciles
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }, [composer, sending, detail])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send],
  )

  const insertMention = useCallback(
    (handle: string) => {
      setComposer((prev) => {
        const v = prev.trim()
        return `${v ? v + ' ' : ''}@${handle} `
      })
    },
    [],
  )

  // PATCH the session's mode (auto/assist). Optimistically sets the override,
  // then persists; on failure the override reverts to the session's stored mode.
  const [patchingMode, setPatchingMode] = useState(false)
  const switchMode = useCallback(
    async (mode: LabSessionMode) => {
      if (!detail || patchingMode) return
      setModeOverride(mode)
      setPatchingMode(true)
      try {
        const updated = await patchLabSession({ sessionId: detail.session.id, mode })
        setDetail((prev) =>
          prev ? { ...prev, session: { ...prev.session, mode: updated.mode } } : prev,
        )
        setSessions((prev) => prev.map((s) => (s.id === updated.id ? { ...s, mode: updated.mode } : s)))
      } catch {
        // revert — the PATCH failed; fall back to the persisted mode
        setModeOverride(detail.session.mode)
      } finally {
        setPatchingMode(false)
      }
    },
    [detail, patchingMode],
  )

  // PATCH the session's status to `done` (the 归档会话 button). Optimistically
  // disables the button via patching flag; on success updates list + detail so
  // the chip flips to 完成. Re-fetches the list so the archived session leaves
  // the default (running) left list.
  const [archiving, setArchiving] = useState(false)
  const archiveSession = useCallback(async () => {
    if (!selected || selected.status === 'done' || archiving) return
    setArchiving(true)
    try {
      await patchLabSession({ sessionId: selected.id, status: 'done' })
      // Refresh the list (default status=running drops the archived one) + the
      // selected detail's status chip.
      const items = await fetchLabSessions()
      setSessions(items)
      setDetail((prev) =>
        prev ? { ...prev, session: { ...prev.session, status: 'done' } } : prev,
      )
      // If the archived session was selected and is no longer in the list,
      // select the first remaining one (or clear).
      if (!items.some((s) => s.id === selected.id)) {
        setSelectedId(items[0]?.id ?? null)
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setArchiving(false)
    }
  }, [selected, archiving])

  return (
    <PageShell
      title="Lab"
      subtitle="多 agent 协作聊天室。自动模式让 agents 自主讨论与做实验；随时切介入模式接管。产出假设、数据、代码与可复现 artifact。"
      fullBleed
      actions={
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void archiveSession()}
            disabled={!selected || selected.status === 'done' || archiving}
            title={selected?.status === 'done' ? '已归档' : '归档会话（置为完成）'}
          >
            {archiving ? '归档中…' : '归档会话'}
          </button>
          <button type="button" className="btn btn-accent btn-sm" disabled title="+ 新实验（MVP 后接入完整配置）">
            + 新实验
          </button>
        </>
      }
    >
      <div className="lab-layout">
        {/* left: session list */}
        <div className="sessions">
          <div className="sessions-head">
            <div className="t">实验会话 · {sessions.length}</div>
          </div>
          <div className="sessions-body">
            {loadingList ? (
              <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
                加载实验会话…
              </div>
            ) : listError ? (
              <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12, color: 'var(--danger)' }}>
                {listError}
              </div>
            ) : sessions.length === 0 ? (
              <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
                暂无实验会话。
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="session-item"
                  role="button"
                  tabIndex={0}
                  aria-selected={s.id === selectedId}
                  onClick={() => setSelectedId(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedId(s.id)
                    }
                  }}
                >
                  <div className="nm">{s.name}</div>
                  {s.description ? <div className="ds">{s.description}</div> : null}
                  <div className="meta">
                    <span className={`status ${s.status}`}>
                      <span className="dot" />
                      {sessionStatusLabel(s.status)}
                    </span>
                    <span className="meta">{s.agentsCount} agents</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* center: chat */}
        <div className="chat">
          <div className="chat-head">
            <div>
              <div className="title">{selected?.name ?? (loadingDetail ? '加载中…' : '选择一个实验会话')}</div>
              <div className="sub">
                {detail
                  ? `${detail.session.agentsCount} agents · ${detail.messages.length} 条消息 · ${detail.session.mode === 'auto' ? '自动模式' : '介入模式'}`
                  : '多 agent 协作线程，run_id 全链路可追溯。'}
              </div>
            </div>
            <div className="mode-switch" role="group" aria-label="实验模式">
              <span className="lbl">模式</span>
              <button
                type="button"
                className="mode-pill"
                aria-pressed={activeMode === 'auto'}
                disabled={patchingMode}
                onClick={() => void switchMode('auto')}
              >
                自动
              </button>
              <button
                type="button"
                className="mode-pill"
                aria-pressed={activeMode === 'assist'}
                disabled={patchingMode}
                onClick={() => void switchMode('assist')}
              >
                介入
              </button>
            </div>
          </div>

          <div className="chat-stream" ref={streamElRef}>
            {threadError ? (
              <div className="muted" style={{ alignSelf: 'center', margin: 'auto', color: 'var(--danger)' }}>
                {threadError}
              </div>
            ) : thread.length === 0 ? (
              <div className="muted" style={{ alignSelf: 'center', margin: 'auto' }}>
                {loadingDetail ? '加载对话线程…' : '暂无对话。在下方发起人工介入。'}
              </div>
            ) : (
              thread.map((m) => <MessageBubble key={m.key} message={m} />)
            )}
          </div>

          <div className="chat-input">
            <div className="chat-input-box">
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder="@orchestrator 安排下一轮实验，对比 skip-connection 与 baseline…"
                aria-label="实验消息"
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={sending || !detail}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void send()}
                disabled={!composer.trim() || sending || !detail}
              >
                {sending ? '发送中…' : '发送'}
              </button>
            </div>
            <div className="chat-input-actions">
              {LAB_MENTION_HANDLES.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="mention"
                  onClick={() => insertMention(h)}
                  disabled={!detail}
                >
                  @{h}
                </button>
              ))}
              <span className="chat-input-hint">
                {activeMode === 'auto'
                  ? '自动模式 · agents 自主协作中。输入即注入讨论。'
                  : '介入模式 · 每步需你确认后再派发。当前等待你的指令。'}
              </span>
            </div>
            {sendError ? (
              <div className="muted" style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                {sendError}
              </div>
            ) : null}
          </div>
        </div>

        {/* right: artifacts */}
        <div className="artifacts">
          <div className="art-head">
            <div className="t">实验产物</div>
            <span className="chip chip-outline">{thread.length}</span>
          </div>
          <div className="art-body">
            {!detail ? (
              <p className="muted" style={{ fontSize: 12 }}>
                {loadingDetail ? '加载实验产物…' : '在左侧选择一个实验会话。'}
              </p>
            ) : (
              <ArtifactsPanel messages={detail.messages} />
            )}
          </div>
        </div>
      </div>
    </PageShell>
  )
}

/** Render a message body with inline @mentions colored as chips.
 *  Uses `splitBodyMentions` so the rendered coloring is driven by the SAME
 *  regex as `parseMentions` — an email-ish `user@host` is NOT colored (the
 *  leading non-word lookbehind in `MENTION_RE` excludes it). */
function renderBody(body: string): React.ReactNode {
  return splitBodyMentions(body).map((seg, i) =>
    seg.mention ? (
      <span key={i} className="msg-mention">
        {seg.text}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  )
}

/** One chat message in the thread. */
function MessageBubble({ message }: { message: LabThreadMessage }): React.ReactElement {
  const isUser = message.role === 'human'
  return (
    <>
      {message.day ? <div className="day-sep">{message.day}</div> : null}
      <div className={`msg ${isUser ? 'user' : ''}`}>
        <div className={`msg-avatar ${message.avatarClass}`}>{message.initial}</div>
        <div className="msg-body">
          <div className="msg-head">
            <span className="msg-name">{message.name}</span>
            <span className="msg-role">{message.roleTag}</span>
            <span className="msg-time">{message.time}</span>
            {message.runId ? <span className="msg-run">· {message.runId.slice(0, 8)}</span> : null}
          </div>
          <div className="msg-bubble">{renderBody(message.body)}</div>
          {message.thinking ? <div className="thinking">💭 {message.thinking}</div> : null}
          {message.toolCall ? <ToolCard tool={message.toolCall} /> : null}
        </div>
      </div>
    </>
  )
}

/** The mono "🛠 tool" card under a message bubble. */
function ToolCard({ tool }: { tool: LabToolCall }): React.ReactElement {
  return (
    <div className="tool-card">
      <div className="th">🛠 {tool.name}</div>
      {tool.input ? <div className="td">{tool.input}</div> : null}
      {tool.output ? <div className="tr">{tool.output}</div> : null}
    </div>
  )
}

/**
 * The right-column artifacts panel. The spec lists no `lab_artifacts` table
 * (artifacts are produced `runs`, surfaced on the Workspace page), so the MVP
 * panel rolls the thread up: the agent set (who has spoken) + the tool calls
 * made + a reproducible-snapshot pointer to the session's run ids. Hypotheses
 * (H1/H2/H3) are a post-MVP structured artifact; the panel surfaces the agent
 * set + tool calls that the MVP thread actually carries.
 */
function ArtifactsPanel({ messages }: { messages: readonly LabMessage[] }): React.ReactElement {
  const agents = useMemo(() => {
    const seen = new Map<string, { agentId: string; role: string }>()
    for (const m of messages) {
      if (m.role === 'human' || !m.agentId) continue
      if (!seen.has(m.agentId)) seen.set(m.agentId, { agentId: m.agentId, role: m.role })
    }
    return [...seen.values()]
  }, [messages])

  const tools = useMemo(() => messages.flatMap((m) => (m.toolCall ? [m.toolCall] : [])), [messages])

  const runIds = useMemo(() => {
    const seen = new Set<string>()
    for (const m of messages) if (m.runId) seen.add(m.runId)
    return [...seen]
  }, [messages])

  return (
    <>
      <div className="art-group">
        <div className="lbl">协作 agents</div>
        {agents.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>
            暂无 agent 发言。
          </div>
        ) : (
          agents.map((a) => (
            <div key={a.agentId} className="art-item">
              <div className="nm">
                <span className={`status ${a.role === 'orchestrator' ? 'running' : 'idle'}`}>
                  <span className="dot" />
                </span>
                {a.agentId}
              </div>
              <div className="mt">@{a.role}</div>
            </div>
          ))
        )}
      </div>

      <div className="art-group">
        <div className="lbl">工具调用</div>
        {tools.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>
            暂无工具调用。
          </div>
        ) : (
          tools.map((t, i) => (
            <div key={`${t.name}-${i}`} className="art-item">
              <div className="nm">🛠 {t.name}</div>
              {t.input ? <div className="mt">{t.input.length > 60 ? t.input.slice(0, 60) + '…' : t.input}</div> : null}
            </div>
          ))
        )}
      </div>

      <div className="art-group">
        <div className="lbl">可复现快照</div>
        {runIds.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>
            暂无 run。
          </div>
        ) : (
          runIds.map((r) => (
            <div key={r} className="art-item">
              <div className="nm">⬢ run {r.slice(0, 8)}</div>
              <div className="mt">run_id · OTel 全链路</div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

/** `HH:MM` for the optimistic message head (local time). */
function hhmmNow(): string {
  const d = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
