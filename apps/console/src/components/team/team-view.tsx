'use client'

/**
 * TeamView — 公司作战室（Team Room，方向 A + D，2026-11-10）。
 *
 * 一屏回答「我的公司此刻在干什么」：
 *   KPI 条（运行/值班/完成/失败/目标/成本/Token）
 *   ├─ 公司活动墙（帧 diff 事件流，行内深链画布旁观）
 *   ├─ 公司时间线（24h 多 run 泳道甘特，lane 按 agent 身份聚合——方向 D）
 *   ├─ 文件黑板（方向 B 观察层：BOARD 任务行 + knowledge/handoff 时间线）
 *   └─ 成员值班卡（谁在干活、干什么、24h 参与量）
 *
 * 数据源单一：GET /api/team/overview 3s 轮询（可见性暂停 + 失败退避），
 * 「直播」由相邻帧 diff 派生（deriveTeamFeed）——MVP 不做 SSE 扇出。
 * 样式随组件走（team.css），遵守既有 dot-* 状态点与 CSS 变量语言。
 */

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useI18n } from '@/i18n'
import { usePolling } from '@/lib/use-polling'
import {
  fetchTeamOverview,
  deriveTeamFeed,
  deriveCompanyTimeline,
  deriveRoster,
  formatUsd,
  formatTokensCompact,
  type TeamOverview,
  type TeamFeedEvent,
} from '@/lib/team-overview'
import { useDirectories } from '@/components/use-directories'
import { SkeletonList } from '@/components/skeleton'
import '@/styles/team.css'

const POLL_MS = 3000
const BACKOFF_MAX_MS = 30_000

function clockOf(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : ''
}

function durationLabel(ms: number | null): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`
}

// ─── KPI 条 ───────────────────────────────────────────────────────────

function KpiChip({
  label,
  value,
  tone,
  primary,
  title,
}: {
  label: string
  value: string
  tone?: 'accent' | 'danger' | 'success' | 'plain'
  primary?: boolean
  title?: string
}): React.ReactElement {
  return (
    <div className={`team-kpi${tone ? ` ${tone}` : ''}${primary ? ' primary' : ''}`} title={title}>
      {/* key=value：数值变化时重挂载，触发 team-kpi-in 轻脉冲（轮9） */}
      <span className="team-kpi-value" key={value}>
        {value}
      </span>
      <span className="team-kpi-label">{label}</span>
    </div>
  )
}

// ─── 公司活动墙 ───────────────────────────────────────────────────────

function ActivityWall({ feed }: { feed: TeamFeedEvent[] }): React.ReactElement | null {
  const { t } = useI18n()
  if (feed.length === 0) {
    return (
      <div className="team-empty">
        <p>{t('还没有事件')}</p>
        <span className="team-empty-hint">
          {t('团队开工后，这里实时滚动每个节点的开始 / 完成 / 失败')}
        </span>
      </div>
    )
  }
  return (
    <div className="team-panel-body team-feed">
      {feed.map((e) => {
        const body = (
          <>
            <span className={`status-dot ${e.kind === 'failed' ? 'dot-failed' : e.kind === 'started' ? 'dot-running' : 'dot-done'}`} />
            <span className="team-feed-time">{clockOf(e.at)}</span>
            <span className="team-feed-agent">{e.agentName}</span>
            <span className="team-feed-text">
              {e.flowName ? `${e.flowName} · ` : ''}
              {e.nodeLabel}
              {e.kind === 'finished' && e.durationMs != null ? `（${durationLabel(e.durationMs)}）` : ''}
            </span>
            {e.kind === 'failed' ? <span className="team-feed-fail">{t('失败')}</span> : null}
          </>
        )
        return e.flowId ? (
          <Link
            key={e.key}
            href={`/workflows/${e.flowId}/canvas?run=${e.runId}`}
            className={`team-feed-row ${e.kind}`}
            title={`${clockOf(e.at)} · ${e.agentName} · ${e.flowName ?? ''} · ${e.nodeLabel}${e.error ? `\n${e.error}` : ''}`}
          >
            {body}
          </Link>
        ) : (
          <span
            key={e.key}
            className={`team-feed-row ${e.kind}`}
            title={`${clockOf(e.at)} · ${e.agentName} · ${e.flowName ?? ''} · ${e.nodeLabel}${e.error ? `\n${e.error}` : ''}`}
          >
            {body}
          </span>
        )
      })}
    </div>
  )
}

// ─── 公司时间线（方向 D：多 run 泳道甘特，lane=agent） ─────────────────

function CompanyTimelineView({
  overview,
}: {
  overview: TeamOverview
}): React.ReactElement {
  const { t } = useI18n()
  const [nowTick, setNowTick] = useState(() => Date.now())
  // 运行中的时间线随秒级心跳延伸（不造时长：endMs=null 的段画到 now）
  usePolling(
    async () => {
      setNowTick(Date.now())
      return overview.running.length > 0
    },
    { intervalMs: 1000, visibilityPause: true },
  )

  const timeline = useMemo(
    () => deriveCompanyTimeline(overview.recentRuns, nowTick),
    [overview.recentRuns, nowTick],
  )

  if (timeline.lanes.length === 0) {
    return (
      <div className="team-empty">
        <p>{t('24 小时内还没有节点执行')}</p>
        <Link className="team-empty-link" href="/">
          {t('去工作流发起一次运行 →')}
        </Link>
      </div>
    )
  }

  const W = 1000
  const H = Math.max(60, 26 * timeline.lanes.length + 8)
  const spanMs = Math.max(1, timeline.maxMs - timeline.minMs)
  const x = (t: number): number => ((t - timeline.minMs) / spanMs) * W
  const nowX = x(nowTick)

  return (
    <div className="team-panel-body team-timeline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="team-timeline-svg"
        role="img"
        aria-label={t('公司时间线')}
      >
        {timeline.lanes.map((lane, i) => {
          const y = i * 26 + 6
          return (
            <g key={lane.agentId ?? `lane-${i}`}>
              {lane.segments.map((s, j) => {
                const x1 = x(s.startMs)
                const x2 = x(s.endMs ?? nowTick)
                const w = Math.max(2, x2 - x1)
                const running = s.status === 'running' && s.endMs == null
                const failed = s.status === 'fail' || s.status === 'failed' || s.status === 'ERROR'
                return (
                  <rect
                    key={`${s.runId}-${j}`}
                    x={x1}
                    y={y}
                    width={w}
                    height={10}
                    rx={2.5}
                    className={`team-tl-seg${running ? ' running' : ''}${failed ? ' failed' : ''}`}
                  >
                    <title>{`${lane.label} · ${s.label} · ${s.flowName ?? ''} · ${durationLabel(
                      (s.endMs ?? nowTick) - s.startMs,
                    )}`}</title>
                  </rect>
                )
              })}
            </g>
          )
        })}
        {overview.running.length > 0 ? (
          <line x1={nowX} x2={nowX} y1={0} y2={H} className="team-tl-now" />
        ) : null}
      </svg>
      <div className="team-tl-lanes">
        {timeline.lanes.map((lane, i) => (
          <div className="team-tl-lane-label" key={lane.agentId ?? `lane-${i}`}>
            <span className={`status-dot ${lane.segments.some((s) => s.status === 'running') ? 'dot-running' : 'dot-done'}`} />
            <span className="team-tl-lane-name" title={lane.label}>
              {lane.label}
            </span>
            <span className="team-tl-lane-count">{lane.segments.length}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 文件黑板（方向 B 观察层） ─────────────────────────────────────────

const TASK_LINE_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$|^\s*[-*]\s*(✅|◐|○|◉)\s*(.+)$/

function BoardLine({ line }: { line: string }): React.ReactElement {
  const m = TASK_LINE_RE.exec(line)
  if (m) {
    const done = m[1] === 'x' || m[1] === 'X' || m[3] === '✅'
    const partial = m[3] === '◐'
    const text = m[2] ?? m[4] ?? ''
    return (
      <div className={`team-board-task${done ? ' done' : ''}${partial ? ' wip' : ''}`}>
        <span className={`status-dot ${done ? 'dot-done' : partial ? 'dot-running' : 'dot-queued'}`} />
        <span>{text}</span>
      </div>
    )
  }
  if (/^#{1,6}\s/.test(line)) {
    return <div className="team-board-heading">{line.replace(/^#+\s*/, '')}</div>
  }
  if (line.trim() === '') return <div className="team-board-gap" />
  return <div className="team-board-line">{line}</div>
}

function BlackboardPanel({ overview }: { overview: TeamOverview }): React.ReactElement {
  const { t } = useI18n()
  const bb = overview.blackboard
  const heading = overview.blackboardDirectoryName
  return (
    <div className="team-panel-body team-blackboard">
      {!bb || !bb.exists ? (
        <div className="team-empty">
          {t('该项目还没有黑板——在项目目录下创建 .agents/（BOARD.md + knowledge/ + handoff/），Agent 们就会通过它共享知识')}
        </div>
      ) : (
        <>
          {bb.boardMd ? (
            <div className="team-board-md">
              {bb.boardMd.split('\n').slice(0, 24).map((line, i) => (
                <BoardLine key={i} line={line} />
              ))}
              {bb.boardMd.split('\n').length > 24 ? (
                <div className="team-board-more">
                  {t('还有 {n} 行——在编辑器里看完整任务板', {
                    n: bb.boardMd.split('\n').length - 24,
                  })}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="team-empty">{t('BOARD.md 还是空的——写下目标与任务行，让团队认领')}</div>
          )}
          <div className="team-board-files">
            {bb.knowledge.length > 0 ? (
              <div className="team-board-file-group">
                <span className="team-board-file-title">{t('共享知识')}</span>
                {bb.knowledge.slice(0, 6).map((e) => (
                  <div className="team-board-file" key={e.relPath} title={e.relPath}>
                    <span>{e.name}</span>
                    <span className="team-board-file-time">{e.mtime ? clockOf(e.mtime) : ''}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {bb.handoff.length > 0 ? (
              <div className="team-board-file-group">
                <span className="team-board-file-title">{t('本轮交接')}</span>
                {bb.handoff.slice(0, 6).map((e) => (
                  <div className="team-board-file" key={e.relPath} title={e.relPath}>
                    <span>{e.name}</span>
                    <span className="team-board-file-time">{e.mtime ? clockOf(e.mtime) : ''}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {heading ? <div className="team-board-dir">{heading}/.agents/</div> : null}
        </>
      )}
    </div>
  )
}

// ─── 成员值班卡 ───────────────────────────────────────────────────────

function RosterCards({ overview }: { overview: TeamOverview }): React.ReactElement {
  const { t } = useI18n()
  const cards = useMemo(() => deriveRoster(overview), [overview])
  if (cards.length === 0) {
    return (
      <div className="team-empty">
        <p>{t('还没有启用的 Agent')}</p>
        <Link className="team-empty-link" href="/agents?tab=plaza">
          {t('去广场启用第一批员工 →')}
        </Link>
      </div>
    )
  }
  return (
    <div className="team-panel-body team-roster">
      {cards.map((c) => (
        <div className={`team-roster-card${c.busy ? ' busy' : ''}`} key={c.agentId}>
          <span className={`status-dot ${c.busy ? 'dot-running' : 'dot-done'}`} />
          <span className="team-roster-name" title={`${c.name} · ${c.kind}`}>
            {c.name}
          </span>
          {c.busy && c.currentTask ? (
            <span className="team-roster-task" title={c.currentTask}>
              {c.currentTask}
            </span>
          ) : (
            <span className="team-roster-idle">{t('空闲')}</span>
          )}
          {c.todayNodes > 0 ? <span className="team-roster-count">24h {c.todayNodes}</span> : null}
        </div>
      ))}
    </div>
  )
}

// ─── 主视图 ───────────────────────────────────────────────────────────

export function TeamView(): React.ReactElement {
  const { t } = useI18n()
  const [overview, setOverview] = useState<TeamOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feed, setFeed] = useState<TeamFeedEvent[]>([])
  const [directoryId, setDirectoryId] = useState<string | null>(null)
  const prevRef = useRef<TeamOverview | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const { directories } = useDirectories()

  const fetcher = async (): Promise<boolean> => {
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      const res = await fetchTeamOverview(directoryId ?? undefined, ctl.signal)
      const events = deriveTeamFeed(prevRef.current, res)
      if (events.length > 0) {
        setFeed((prev) => {
          const seen = new Set(prev.map((e) => e.key))
          return [...events.filter((e) => !seen.has(e.key)), ...prev].slice(0, 200)
        })
      }
      prevRef.current = res
      setOverview(res)
      setError(null)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return true
      setError(err instanceof Error ? err.message : String(err))
      return true // 退避后重试
    }
    return true
  }

  usePolling(fetcher, {
    intervalMs: POLL_MS,
    visibilityPause: true,
    backoffMaxMs: BACKOFF_MAX_MS,
    restartKey: directoryId,
  })

  const k = overview?.kpis

  return (
    <div className="team-view">
      <header className="team-header">
        <div>
          <h1 className="team-title">{t('公司作战室')}</h1>
          <p className="team-subtitle">
            {t('多 Agent 团队的实时鸟瞰——运行、成员、黑板与目标，一屏尽收')}
            {overview ? <span className="team-fresh"> · {t('更新于')} {clockOf(overview.generatedAt)}</span> : null}
          </p>
        </div>
        <div className="team-header-actions">
          {directories.length > 0 ? (
            <select
              className="team-dir-select"
              value={directoryId ?? overview?.blackboard?.directoryId ?? ''}
              onChange={(e) => setDirectoryId(e.target.value || null)}
              aria-label={t('黑板项目目录')}
            >
              <option value="">{t('跟随团队（自动）')}</option>
              {directories.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : null}
          <Link href="/goals" className="team-goals-link">
            {t('目标看板')}
            {k && k.goalsActive > 0 ? <span className="team-goals-count">{k.goalsActive}</span> : null}
          </Link>
        </div>
      </header>

      {error ? <div className="team-error">{t('作战室数据拉取失败')}: {error}</div> : null}

      <div className="team-kpis" role="status">
        <div className="team-kpi-group">
          <span className="team-kpi-group-label">{t('此刻')}</span>
          <KpiChip label={t('个运行')} value={String(k?.runningRuns ?? 0)} tone="accent" primary />
          <KpiChip label={t('个 agent 值班中')} value={String(k?.activeAgents ?? 0)} tone="accent" primary />
        </div>
        <div className="team-kpi-group">
          <span className="team-kpi-group-label">{t('24 小时')}</span>
          <KpiChip label={t('完成')} value={String(k?.runsCompleted ?? 0)} tone="success" />
          <KpiChip label={t('失败')} value={String(k?.runsFailed ?? 0)} tone={(k?.runsFailed ?? 0) > 0 ? 'danger' : 'plain'} />
          <KpiChip
            label={t('成本')}
            value={formatUsd(k?.cost ?? 0)}
            title={k && k.unpricedTokens > 0 ? t('另有 {n} 未计价 token', { n: formatTokensCompact(k.unpricedTokens) }) : undefined}
          />
          <KpiChip label={t('Token')} value={formatTokensCompact(k?.tokens ?? 0)} />
        </div>
        <div className="team-kpi-group">
          <span className="team-kpi-group-label">{t('目标')}</span>
          <KpiChip label={t('活跃')} value={String(k?.goalsActive ?? 0)} tone="accent" />
          <KpiChip label={t('今日达成')} value={String(k?.goalsAchievedToday ?? 0)} tone="success" />
        </div>
      </div>

      <div className="team-grid">
        <section className="team-panel">
          <h2 className="team-panel-title">{t('公司活动墙')}</h2>
          {overview ? <ActivityWall feed={feed} /> : <div className="team-panel-body"><SkeletonList rows={5} /></div>}
        </section>

        <section className="team-panel">
          <h2 className="team-panel-title">{t('公司时间线 · 24h')}</h2>
          {overview ? <CompanyTimelineView overview={overview} /> : <div className="team-panel-body"><SkeletonList rows={4} /></div>}
        </section>

        <section className="team-panel">
          <h2 className="team-panel-title">{t('文件黑板')}</h2>
          {overview ? <BlackboardPanel overview={overview} /> : <div className="team-panel-body"><SkeletonList rows={4} /></div>}
        </section>

        <section className="team-panel">
          <h2 className="team-panel-title">{t('成员值班')}</h2>
          {overview ? <RosterCards overview={overview} /> : <div className="team-panel-body"><SkeletonList rows={4} /></div>}
        </section>
      </div>
    </div>
  )
}
