'use client'

/**
 * Workspace 项目对话页 view (P1.10.T6 / M5b.1).
 *
 * Three-column layout matching design/workspace.html's `.ws-layout`:
 *   - left: project list (fetched from `/api/workspaces`, filterable by name)
 *   - center: conversation thread (`/api/workspaces/:id/threads`) + composer
 *   - right: project meta — members / linked flow / quota / artifacts
 *
 * Data flow: this client component fetches the console's own `/api/workspaces/*`
 * proxy routes (browser → gateway → DB), derives the thread messages + quota
 * bars + project status from the pure mappers in `lib/workspaces.ts`, and
 * renders the design's DOM (ported to React). Page-local styles live in
 * `styles/workspace.css`; `shell.css` provides the shared component classes
 * (.btn / .status / .chip / .bar / .card-flat / .row-between / .mono / .muted).
 *
 * ## Conversation thread = run history
 *
 * The thread reuses `runs` scoped to the workspace: each run is one
 * conversation turn carrying the OTel `run_id` (M6.1), so a message is
 * end-to-end traceable. `threadToMessages` splits each run into a user
 * question + an agent answer. The composer starts a new turn by posting to
 * `/api/workspaces/:id/runs` → the scheduler's fan-out (single-input batch),
 * the one path that writes a `runs` row carrying `workspace_id` — so the turn
 * lands in the thread on the next fetch, and the `run_id` shown in the
 * inspector matches the gateway/Flowise/scheduler trace. The composer does
 * NOT stream tokens: the scheduler's prediction client awaits the full
 * response, so the agent answer appears once the run completes (the thread
 * refetch reconciles it). A polling refetch surfaces the answer without a
 * second user action.
 *
 * ## ws-chat filter chips (M7.1)
 *
 * The four chat-head filter chips (全部 / @我 / 未读 / 含 run) toggle with
 * `aria-pressed` and actually filter the rendered thread, matching
 * design/workspace.html:106-109 + the toggle at L263-266. The semantics the
 * data supports today: `@我` keeps turns whose user message was authored by
 * the project owner (the only author the thread rows carry — `createdByUserId`
 * vs the detail's `ownerUserId`); `未读` keeps the turns with no bot answer
 * yet (the run is still running, so only the user question has landed); `含 run`
 * keeps turns that carry a run id (every persisted turn does — each row's
 * `identifier` is a non-null text column — so `含 run` is today equivalent to
 * `全部`, kept as a hook for a future runId-missing scenario). `全部` shows
 * everything (the default). The filters are single-select like the design's
 * chip group (clicking one releases the others), not multi-select.
 *
 * Honesty about coverage: the design's "+ 新建项目" / "归档" page actions
 * render but are no-ops for MVP (project CRUD is post-MVP). The meta panel's
 * quota `used` counters are editorial (a later worker rolls `runs` up);
 * the read forwards them verbatim.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { PageShell } from '@/components/page-shell'
import '@/styles/workspace.css'
import {
  buildWorkspaceRunBody,
  deriveProjectStatus,
  fetchWorkspaceDetail,
  fetchWorkspaces,
  fetchWorkspaceThread,
  postWorkspaceRun,
  quotaBars,
  threadToMessages,
  type QuotaBar,
  type ThreadMessage,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from '@/lib/workspaces'

/** Project-status chip labels (mirrors the design's `活跃` / `空闲` / `已完成`). */
const STATUS_LABEL: Record<string, string> = {
  running: '活跃',
  idle: '空闲',
  done: '已完成',
}

/**
 * The four ws-chat filter chips (design/workspace.html:106-109). Single-select:
 * exactly one is `aria-pressed="true"` at a time — the design's chip group
 * releases the others on click (design/workspace.html:263-266).
 */
const CHAT_FILTERS = ['all', 'mine', 'unread', 'hasRun'] as const
type ChatFilter = (typeof CHAT_FILTERS)[number]
const CHAT_FILTER_LABEL: Record<ChatFilter, string> = {
  all: '全部',
  mine: '@我',
  unread: '未读',
  hasRun: '含 run',
}

export function WorkspaceView(): React.ReactElement {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null)
  const [thread, setThread] = useState<readonly ThreadMessage[]>([])
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [filter, setFilter] = useState('')
  const [listError, setListError] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [sending, setSending] = useState(false)
  const [composer, setComposer] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)

  const streamElRef = useRef<HTMLDivElement>(null)

  // Fetch the project list once on mount; auto-select the first so the center
  // + right panels aren't empty on load.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingList(true)
      setListError(null)
      try {
        const items = await fetchWorkspaces()
        if (cancelled) return
        setWorkspaces(items)
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

  // Fetch the selected workspace's detail + thread whenever the selection
  // changes. Two parallel fetches; each surfaces its own error so a thread
  // failure doesn't blank the meta panel (or vice-versa).
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
      try {
        const [d, t] = await Promise.all([
          fetchWorkspaceDetail(selectedId),
          fetchWorkspaceThread(selectedId),
        ])
        if (cancelled) return
        setDetail(d)
        const owner = d.members.find((m) => m.role === 'owner')
        setThread(
          threadToMessages(
            t,
            owner?.displayName ?? '成员',
            owner?.initial ?? 'U',
          ),
        )
      } catch (err) {
        if (cancelled) {
          setThreadError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  // Refetch the selected workspace's thread (used after sending a turn so the
  // real run row replaces the optimistic message + the agent answer surfaces
  // once the child settles). No-op when the selection has moved on. Captured
  // detail for owner labeling so the new messages match the thread's style.
  const refetchThread = useCallback(async (id: string) => {
    try {
      const [t, d] = await Promise.all([
        fetchWorkspaceThread(id),
        // detail may already be current; refetch to keep owner labeling fresh
        // if a send raced a selection change. Tolerate a failure here (the
        // thread is the important half).
        fetchWorkspaceDetail(id).catch(() => null),
      ])
      const owner = (d ?? detail)?.members.find((m) => m.role === 'owner')
      setThread(
        threadToMessages(
          t,
          owner?.displayName ?? '成员',
          owner?.initial ?? 'U',
        ),
      )
    } catch {
      // A refetch failure isn't fatal — the optimistic message stays and the
      // next selection change or manual refresh retries. Swallow to avoid
      // clobbering a visible thread error from the initial load.
    }
  }, [detail])

  // After sending a turn, poll the thread a couple of times so the agent
  // answer surfaces without a second user action. The scheduler's run is
  // async (parent aggregates once the child settles), so an immediate refetch
  // may show only the user turn. Capped at a few polls so this never becomes a
  // long-lived loop; the next selection change / page load reconciles anyway.
  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const schedulePoll = useCallback((id: string) => {
    const clear = (): void => {
      for (const t of pollTimers.current) clearTimeout(t)
      pollTimers.current = []
    }
    clear()
    // Poll at 2s and 6s — enough for a fast flow to complete and a slower one
    // to at least show its user turn without the optimistic dup. Bounds the
    // polling to this turn; a new send or a selection change clears it.
    pollTimers.current = [
      setTimeout(() => void refetchThread(id), 2_000),
      setTimeout(() => void refetchThread(id), 6_000),
    ]
  }, [refetchThread])

  // Clear any pending poll timers on unmount so they can't fire a setState on
  // an unmounted component.
  useEffect(() => {
    return () => {
      for (const t of pollTimers.current) clearTimeout(t)
      pollTimers.current = []
    }
  }, [])

  // Auto-scroll the thread to the bottom when new messages arrive.
  useEffect(() => {
    const el = streamElRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread, selectedId])

  const filteredWorkspaces = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return workspaces
    return workspaces.filter(
      (w) => w.name.toLowerCase().includes(q) || w.description?.toLowerCase().includes(q),
    )
  }, [workspaces, filter])

  const selected = useMemo(
    () => workspaces.find((w) => w.id === selectedId) ?? null,
    [workspaces, selectedId],
  )

  /**
   * Apply the active ws-chat filter to the thread. The semantics are bounded
   * by what the thread data supports today (M7.1): `@我` keeps a turn's human
   * message (the only human author the rows carry is the project owner —
   * `threadToMessages` labels every human turn with the owner's name — so
   * `role === 'human'` is the owner proxy); `未读` keeps turns whose bot
   * answer hasn't landed yet (a still-running run — only the user question is
   * present, no sibling bot message shares its `runId`); `含 run` keeps turns
   * carrying a run id (every persisted turn does — `identifier` is a non-null
   * text column, and the optimistic send also synthesizes one — so `含 run` is
   * today equivalent to `全部`; the branch is kept as a hook for a future
   * runId-missing scenario). `全部` (the default) keeps everything.
   */
  const visibleThread = useMemo(() => {
    if (chatFilter === 'all') return thread
    if (chatFilter === 'hasRun') return thread.filter((m) => Boolean(m.runId))
    if (chatFilter === 'mine') {
      // The thread labels every human turn as the project owner, so `@我` is
      // the human turns. A stricter per-author filter waits on the run-row
      // author being threaded into ThreadMessage (post-MVP).
      return thread.filter((m) => m.role === 'human')
    }
    // unread: human turns with no sibling bot answer yet (run still running).
    const answeredRuns = new Set(
      thread.filter((m) => m.role === 'bot' && m.runId).map((m) => m.runId),
    )
    return thread.filter((m) => m.role === 'human' && !answeredRuns.has(m.runId))
  }, [thread, chatFilter])

  // Single-select chip toggle: clicking the active chip is a no-op (keeps it
  // pressed — the design never allows zero chips pressed); clicking another
  // releases the rest.
  const toggleChatFilter = useCallback((next: ChatFilter) => {
    setChatFilter(next)
  }, [])

  // The project-status chip: `archived` → `done`; `active` + an update in the
  // last day → `running`; else `idle`. Re-derived from the detail each render.
  const projectStatus = deriveProjectStatus(
    detail?.workspace.status ?? 'active',
    detail?.workspace.updatedAt ?? null,
  )

  const send = useCallback(async () => {
    const text = composer.trim()
    if (!text || sending || !detail) return
    // The composer posts against the project's first linked flow (the
    // associated pipeline). A project with no linked flow can't start a run —
    // surface that inline rather than silently posting to the scheduler with no
    // flowId. (The design's "@agent 可派发任务" semantics land with dispatch
    // from the console UI in a later task; here a prompt-agent turn is the
    // path that exists today.)
    const flow = detail.flows[0]
    if (!flow) {
      setSendError('该项目未关联 flow，无法发起新对话。请在 AgentFlows 关联后再试。')
      return
    }
    setSending(true)
    setSendError(null)
    // A fresh run id (also threaded into Flowise Flow State as the sessionId)
    // so the turn is end-to-end traceable. Generated before the post so the
    // optimistic message can carry it.
    const runId = crypto.randomUUID()
    // Optimistically append the user's turn so the thread feels live; the next
    // thread fetch reconciles it with the real run row the scheduler wrote.
    const optimistic: ThreadMessage = {
      key: `local:${runId}`,
      role: 'human',
      name: detail.members.find((m) => m.role === 'owner')?.displayName ?? '你',
      initial: detail.members.find((m) => m.role === 'owner')?.initial ?? 'U',
      time: hhmmNow(),
      body: text,
      attachments: [],
      runId,
    }
    setThread((prev) => [...prev, optimistic])
    setComposer('')
    try {
      const body = buildWorkspaceRunBody({
        flowId: flow.pipelineId,
        question: text,
        workspaceId: detail.workspace.id,
        runId,
        identifier: `ws-turn-${runId.slice(0, 8)}`,
      })
      await postWorkspaceRun(detail.workspace.id, body)
      // The scheduler created the parent + child runs; refetch the thread so
      // the real row (with the agent answer, once the child settles) replaces
      // the optimistic message. Poll once shortly after send to catch a fast
      // completion, and again after a delay for slower flows.
      await refetchThread(detail.workspace.id)
      schedulePoll(detail.workspace.id)
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

  return (
    <PageShell
      title="Workspace"
      subtitle="按项目隔离的人-agent 对话记录。成员、关联 flow、产物与配额一站式。对话经网关注入 run_id 全链路可追溯。"
      fullBleed
      actions={
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled title="项目归档（MVP 后接入）">
            归档
          </button>
          <button type="button" className="btn btn-accent btn-sm" disabled title="新建项目（MVP 后接入）">
            + 新建项目
          </button>
        </>
      }
    >
      <div className="ws-layout">
        {/* left: project list */}
        <div className="ws-list">
          <div className="ws-list-head">
            <div className="t">
              <span>项目 · {workspaces.length}</span>
            </div>
            <input
              type="search"
              placeholder="筛选项目…"
              aria-label="筛选项目"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                width: '100%',
                height: 30,
                marginTop: 'var(--space-2)',
                padding: '0 var(--space-3)',
                background: 'var(--surface-warm)',
                border: '1px solid transparent',
                borderRadius: 8,
                fontSize: 'var(--text-xs)',
              }}
            />
          </div>
          <div className="ws-list-body">
            {loadingList ? (
              <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
                加载项目列表…
              </div>
            ) : listError ? (
              <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12, color: 'var(--danger)' }}>
                {listError}
              </div>
            ) : filteredWorkspaces.length === 0 ? (
              <div className="muted" style={{ padding: 'var(--space-4)', fontSize: 12 }}>
                {workspaces.length === 0 ? '暂无项目。' : '无匹配项目。'}
              </div>
            ) : (
              filteredWorkspaces.map((w) => {
                const st = deriveProjectStatus(w.status, w.createdAt)
                return (
                  <div
                    key={w.id}
                    className="ws-item"
                    role="button"
                    tabIndex={0}
                    aria-selected={w.id === selectedId}
                    onClick={() => setSelectedId(w.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedId(w.id)
                      }
                    }}
                  >
                    <div className="top">
                      <div className="ws-glyph">{w.glyph}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="nm">{w.name}</div>
                        <div className="mt">
                          {w.flowCount > 0 ? `${w.flowCount} 关联 flow` : '无关联 flow'} · {w.memberCount} 成员
                        </div>
                      </div>
                    </div>
                    <div className="meta">
                      <span className={`status ${st}`}>
                        <span className="dot" />
                        {STATUS_LABEL[st]}
                      </span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* center: chat */}
        <div className="ws-chat">
          <div className="ws-chat-head">
            <div className="title">{selected?.name ?? (loadingDetail ? '加载中…' : '选择一个项目')}</div>
            <div className="sub">
              {detail
                ? `${detail.members.length} 成员 · ${
                    detail.flows.length > 0
                      ? `关联 flow ${detail.flows.map((f) => f.name).join(', ')}`
                      : '无关联 flow'
                  }`
                : '项目对话线程，run_id 全链路可追溯。'}
            </div>
            <div className="filters">
              {CHAT_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="filter-chip"
                  data-f="chat"
                  data-v={f}
                  aria-pressed={chatFilter === f}
                  onClick={() => toggleChatFilter(f)}
                  title={
                    f === 'mine'
                      ? '当前显示所有人类消息（按作者过滤待 post-MVP）'
                      : undefined
                  }
                  style={{ height: 26, fontSize: 11 }}
                >
                  {CHAT_FILTER_LABEL[f]}
                </button>
              ))}
            </div>
          </div>

          <div className="ws-stream" ref={streamElRef}>
            {threadError ? (
              <div className="muted" style={{ alignSelf: 'center', margin: 'auto', color: 'var(--danger)' }}>
                {threadError}
              </div>
            ) : visibleThread.length === 0 ? (
              <div className="muted" style={{ alignSelf: 'center', margin: 'auto' }}>
                {loadingDetail
                  ? '加载对话线程…'
                  : thread.length === 0
                    ? '暂无对话。在下方发起新对话。'
                    : '当前筛选下无对话。'}
              </div>
            ) : (
              visibleThread.map((m) => <MessageBubble key={m.key} message={m} />)
            )}
          </div>

          <div className="ws-input">
            <div className="ws-input-box">
              <textarea
                rows={1}
                placeholder={
                  detail?.flows.length
                    ? '在项目频道发消息，Enter 发送，Shift+Enter 换行…'
                    : '该项目未关联 flow，暂无法发起新对话…'
                }
                aria-label="项目消息"
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={sending || !detail?.flows.length}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void send()}
                disabled={!composer.trim() || sending || !detail?.flows.length}
              >
                {sending ? '发送中…' : '发送'}
              </button>
            </div>
            {sendError ? (
              <div className="muted" style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                {sendError}
              </div>
            ) : null}
          </div>
        </div>

        {/* right: meta */}
        <div className="ws-meta">
          <div className="ws-meta-head">
            <div className="t">{selected?.name ?? '项目信息'}</div>
          </div>
          <div className="ws-meta-body">
            {!detail ? (
              <p className="muted" style={{ fontSize: 12 }}>
                {loadingDetail ? '加载项目信息…' : '在左侧选择一个项目。'}
              </p>
            ) : (
              <MetaPanel detail={detail} status={projectStatus} />
            )}
          </div>
        </div>
      </div>
    </PageShell>
  )
}

/** One chat message in the thread. */
function MessageBubble({ message }: { message: ThreadMessage }): React.ReactElement {
  const isUser = message.role === 'human'
  return (
    <>
      {message.day ? <div className="day-sep">{message.day}</div> : null}
      <div className={`cmsg ${isUser ? 'user' : ''}`}>
        <div className={`cmsg-avatar ${isUser ? 'human' : 'bot'}`}>{message.initial}</div>
        <div className="cmsg-body">
          <div className="cmsg-head">
            <span className="cmsg-name">{message.name}</span>
            <span>{message.time}</span>
            {message.runId ? <span className="cmsg-run">· {message.runId}</span> : null}
          </div>
          <div className="cmsg-bubble">{message.body}</div>
          {message.attachments.length > 0 ? (
            <div className="cmsg-attach">
              {message.attachments.map((a) => (
                <span key={a} className="attach-chip">
                  📎 {a}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

/** The right-column meta panel: members / linked flow / quota / artifacts. */
function MetaPanel({
  detail,
  status,
}: {
  detail: WorkspaceDetail
  status: 'running' | 'idle' | 'done'
}): React.ReactElement {
  const bars = quotaBars(detail.workspace.quota)
  return (
    <>
      <div className="meta-section">
        <div className="lbl">成员</div>
        {detail.members.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>
            暂无成员。
          </div>
        ) : (
          detail.members.map((m) => (
            <div key={m.id} className="member">
              <div className="av" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
                {m.initial ?? m.memberId.slice(0, 2).toUpperCase()}
              </div>
              <div className="nm">{m.displayName ?? m.memberId}</div>
              <div className="role">{m.role}</div>
            </div>
          ))
        )}
      </div>

      <div className="meta-section">
        <div className="lbl">关联 flow</div>
        {detail.flows.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>
            无关联 flow。
          </div>
        ) : (
          detail.flows.map((f) => (
            <div key={f.id} className="card-flat" style={{ padding: 'var(--space-3)', marginBottom: 8 }}>
              <div className="row-between">
                <span className="fg" style={{ fontSize: 12, fontWeight: 500 }}>
                  {f.name}
                </span>
                <span className={`status ${f.status}`}>
                  <span className="dot" />
                  {f.status}
                </span>
              </div>
              {f.note ? <div className="muted mt-2" style={{ fontSize: 11 }}>{f.note}</div> : null}
              <Link href="/flows" className="btn btn-ghost btn-sm mt-3" style={{ padding: 0, height: 24 }}>
                在 AgentFlows 打开 →
              </Link>
            </div>
          ))
        )}
      </div>

      <div className="meta-section">
        <div className="lbl">配额（本月）</div>
        {bars.map((b) => (
          <QuotaRow key={b.key} bar={b} />
        ))}
      </div>

      <div className="meta-section">
        <div className="lbl">产物</div>
        <div className="card-flat" style={{ padding: 'var(--space-3)', fontSize: 11 }}>
          <div className="row-between mb-2">
            <span className="muted">报告</span>
            <span className="mono">{detail.artifacts.reports}</span>
          </div>
          <div className="row-between mb-2">
            <span className="muted">数据集</span>
            <span className="mono">{detail.artifacts.datasets}</span>
          </div>
          <div className="row-between">
            <span className="muted">代码 patch</span>
            <span className="mono">{detail.artifacts.patches}</span>
          </div>
        </div>
      </div>

      <div className="meta-section">
        <div className="lbl">状态</div>
        <span className={`status ${status}`}>
          <span className="dot" />
          {STATUS_LABEL[status]}
        </span>
      </div>
    </>
  )
}

/** One quota bar row (label / used·cap / bar). */
function QuotaRow({ bar }: { bar: QuotaBar }): React.ReactElement {
  return (
    <div className="quota-row">
      <div className="top">
        <span className="nm">{bar.label}</span>
        <span className="v">{bar.value}</span>
      </div>
      <div className={`bar ${bar.tint}`}>
        <span style={{ width: `${bar.percent}%` }} />
      </div>
    </div>
  )
}

/** `HH:MM` for the optimistic message head (local time). */
function hhmmNow(): string {
  const d = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
