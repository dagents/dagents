'use client'

/**
 * CanvasTraceView —— 运行结果「轨迹」视图（2026-10-01）。
 *
 * 参考 deepseek-harness Trajectory 子系统的交互语法（Chrome Network 面片
 * 隐喻），按工作流语义适配为**节点泳道甘特**：
 *  - 时间线概览：一行一节点，横条 = 执行区间（迭代重跑多段并列），条内
 *    打工具/错误事件刻度；拖拽 ≥3px 框选过滤台账、单击选最近记录、滚轮
 *    缩放、右键平移/重置、Esc/双击复位、hover 提示起止·时长·状态。
 *  - 事件台账：按节点分区（状态驱动自动展开——running/failed 展开、干净
 *    态收拢，用户手动开关优先），行 = kind pill + 单行内容 + 等宽时间列。
 *  - Inspector 侧面板：拖宽可调（双击复位）；节点（概览/输入/输出/用量）
 *    与事件（全文 detail）两类检视，复用 ResultViewer 全屏查看。
 *
 * 数据源（lib/run-trace-model 单源）：直播帧模型（use-run-live trace，
 * run-live SSE）优先，回退 DB spans 快照（buildTraceFromSpans）——两条路
 * 产出同一 RunTraceModel，本组件不感知数据来自哪边。
 *
 * 诚实运行态：开段时长显示 —、横条随秒级 tick 延伸（不造时长）；旧运行
 * events 无时间戳时 actual/duration 投影自动降级 sequence 并提示。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Icon, type IconName } from '@/components/icon'
import { ResultViewer } from '@/components/result-viewer'
import { useI18n } from '@/i18n'
import type { RunNodeSpan } from '@/lib/node-spans'
import { extractOutputText, formatTokensBadge } from '@/lib/run-terminal-format'
import {
  deriveTimeline,
  formatTraceClock,
  formatTraceDuration,
  timelineFocusIndexes,
  type RunTraceModel,
  type TraceNodeLane,
  type TraceRecord,
  type TraceRecordKind,
  type TraceTimelineMode,
} from '@/lib/run-trace-model'
import './canvas-trace.css'

export type TraceRunState = 'idle' | 'running' | 'done' | 'failed' | 'awaiting'

export interface CanvasTraceViewProps {
  runState: TraceRunState
  /** 轨迹模型（面板已选好直播/DB 路）。 */
  model: RunTraceModel
  /** DB spans（Inspector 的输入/输出/用量载荷按 nodeId 查这里）。 */
  spans: RunNodeSpan[]
}

/** 泳道几何：行距随节点数自适应，总高封顶避免挤爆面板。 */
const PITCH_MAX = 22
const PITCH_MIN = 13
const PLOT_MAX_H = 176
const SPAN_H = 8
const MIN_DRAG_PX = 3
const TOOLTIP_DELAY_MS = 350
const INSPECTOR_DEFAULT_W = 320
const INSPECTOR_MIN_W = 240
const INSPECTOR_MAX_W = 560

type Range = { start: number; end: number }

type Selection = { type: 'node'; nodeId: string } | { type: 'record'; index: number } | null

const orderedRange = (a: number, b: number): Range => (a <= b ? { start: a, end: b } : { start: b, end: a })
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 台账行事件刻度种类（thinking 太密不刻，正文/状态不刻）。 */
const TICK_KINDS: readonly string[] = ['tool', 'tool_result', 'error', 'user_input']

function kindIcon(kind: TraceRecordKind): IconName {
  if (kind === 'tool') return 'wrench'
  if (kind === 'tool_result') return 'cornerDownRight'
  if (kind === 'error') return 'alertTriangle'
  if (kind === 'thinking') return 'brain'
  if (kind === 'user_input') return 'user'
  if (kind === 'nodeStart') return 'play'
  if (kind === 'nodeEnd') return 'check'
  return 'point'
}

function statusClass(status: string): string {
  if (status === 'done' || status === 'completed') return 'ok'
  if (status === 'failed') return 'err'
  if (status === 'running') return 'run'
  if (status === 'paused' || status === 'awaiting_input') return 'warn'
  return 'neutral'
}

/** 台账行/Inspector 的载荷 → 可读文本（截断预览，全文走 Inspector）。 */
function payloadPreview(v: unknown, max = 2000): string {
  if (v == null) return ''
  const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1)
  return text.length > max ? text.slice(0, max) + ` …(${text.length})` : text
}

export function CanvasTraceView({ runState, model, spans }: CanvasTraceViewProps): React.ReactElement {
  const { t } = useI18n()
  const running = runState === 'running' || runState === 'awaiting'

  /* ── 秒级心跳：仅运行中驱动（开段延伸/now 游标），终态零开销 ── */
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => tick(), 1000)
    return () => clearInterval(timer)
  }, [running])
  const nowMs = running ? Date.now() : null

  /* ── 投影模式（localStorage 记忆；无时间戳数据自动降级 sequence） ── */
  const [mode, setMode] = useState<TraceTimelineMode>(() => {
    try {
      const v = window.localStorage.getItem('dagents.canvas.traceMode')
      return v === 'sequence' || v === 'duration' ? v : 'actual'
    } catch {
      return 'actual'
    }
  })
  const switchMode = useCallback((v: TraceTimelineMode): void => {
    setMode(v)
    try {
      window.localStorage.setItem('dagents.canvas.traceMode', v)
    } catch {
      /* 无 localStorage 则仅内存切换 */
    }
  }, [])

  const primaryTl = useMemo(() => deriveTimeline(model, mode, nowMs), [model, mode, nowMs])
  const degraded = primaryTl == null && mode !== 'sequence'
  const tl = primaryTl ?? deriveTimeline(model, 'sequence', nowMs)
  const effMode: TraceTimelineMode = primaryTl ? mode : 'sequence'

  /* ── 框选 / 缩放视窗 / 悬停提示 ── */
  const [range, setRange] = useState<Range | null>(null)
  const [draft, setDraft] = useState<Range | null>(null)
  const [viewport, setViewport] = useState<Range | null>(null)
  const [hoverTip, setHoverTip] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const focusSet = useMemo(
    () => (range ? timelineFocusIndexes(model, range, effMode, nowMs) : null),
    [model, range, effMode, nowMs],
  )

  /* ── 台账分区展开态：状态驱动自动 + 手动覆盖优先 ── */
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({})
  // 新一轮 run 清空手动记忆（同 nodeId 跨轮残留会让自动展开失效）。
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (runState === 'running' && !wasRunningRef.current) {
      setManualOpen({})
      setRange(null)
      setViewport(null)
      setSelected(null)
    }
    wasRunningRef.current = runState === 'running'
  }, [runState])

  /* ── 选中（Inspector 数据源） ── */
  const [selected, setSelected] = useState<Selection>(null)
  const ledgerRef = useRef<HTMLDivElement | null>(null)

  const domain: Range = viewport ?? { start: tl?.start ?? 0, end: tl?.end ?? 1 }
  const domainDur = Math.max(1, domain.end - domain.start)
  const pct = (x: number): number => ((x - domain.start) / domainDur) * 100

  /* ── 时间线指针交互（dsh TrajectoryTimeline 语法） ── */
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; anchorX: number; anchorT: number } | null>(null)
  const panRef = useRef<{ pointerId: number; anchorX: number; anchorStart: number; moved: boolean } | null>(null)
  const [panning, setPanning] = useState(false)

  const resetView = useCallback((): void => {
    setRange(null)
    setViewport(null)
    setDraft(null)
  }, [])

  // 滚轮缩放：锚定光标分数位，非被动监听（需 preventDefault）。
  useEffect(() => {
    const el = trackRef.current
    if (!el || !tl) return
    const onWheel = (e: globalThis.WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const frac = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
      const fullDur = Math.max(1, tl.end - tl.start)
      const nextDur = clamp(
        domainDur * Math.exp(e.deltaY * 0.0015),
        fullDur / 80,
        fullDur,
      )
      if (nextDur >= fullDur * 0.999) {
        setViewport(null)
        return
      }
      const anchorT = domain.start + frac * domainDur
      const nextStart = clamp(anchorT - frac * nextDur, tl.start, tl.end - nextDur)
      setViewport({ start: nextStart, end: nextStart + nextDur })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tl, domain.start, domainDur])

  const fractionAt = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
  }

  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button === 2) {
      panRef.current = { pointerId: e.pointerId, anchorX: e.clientX, anchorStart: domain.start, moved: false }
      setPanning(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0 || !tl) return
    const frac = fractionAt(e)
    dragRef.current = { pointerId: e.pointerId, anchorX: e.clientX, anchorT: domain.start + frac * domainDur }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft({ start: dragRef.current.anchorT, end: dragRef.current.anchorT })
  }

  const onTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan && pan.pointerId === e.pointerId) {
      if (Math.abs(e.clientX - pan.anchorX) >= MIN_DRAG_PX) pan.moved = true
      if (!pan.moved) return
      const rect = e.currentTarget.getBoundingClientRect()
      if (!tl || viewport == null) return // 全景观不平移（dsh pannable = 已缩放）
      const dx = (e.clientX - pan.anchorX) / Math.max(1, rect.width)
      const nextStart = clamp(pan.anchorStart - dx * domainDur, tl.start, tl.end - domainDur)
      setViewport({ start: nextStart, end: nextStart + domainDur })
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId || !tl) return
    const pointT = domain.start + fractionAt(e) * domainDur
    setDraft(orderedRange(drag.anchorT, pointT))
  }

  const onTrackPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan && pan.pointerId === e.pointerId) {
      panRef.current = null
      setPanning(false)
      if (!pan.moved) resetView() // 右键单击 = 复位（清框选 + 视窗）
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId || !tl) return
    dragRef.current = null
    const pointT = domain.start + fractionAt(e) * domainDur
    const selected0 = orderedRange(drag.anchorT, pointT)
    setDraft(null)
    const isClick = Math.abs(e.clientX - drag.anchorX) < MIN_DRAG_PX
    if (isClick) {
      // 单击：选最近记录并滚动台账（框选清除）
      setRange(null)
      if (tl.recordX.length > 0) {
        let best = 0
        let bestDist = Infinity
        tl.recordX.forEach((x, i) => {
          const d = Math.abs(x - pointT)
          if (d < bestDist) {
            bestDist = d
            best = i
          }
        })
        const rec = model.records[best]
        if (rec) {
          setManualOpen((m) => ({ ...m, [rec.nodeId]: true }))
          setSelected({ type: 'record', index: rec.index })
          requestAnimationFrame(() => {
            ledgerRef.current
              ?.querySelector(`[data-record-index='${rec.index}']`)
              ?.scrollIntoView({ block: 'nearest' })
          })
        }
      }
      return
    }
    // 框选：过窄区间放大到最小可读宽度（至少容纳 ~8 条记录的域宽）
    const minSel = domainDur / Math.max(8, tl.recordX.length)
    const committed =
      selected0.end - selected0.start < minSel
        ? {
            start: clamp(selected0.start - minSel / 2, tl.start, tl.end),
            end: 0,
          }
        : selected0
    if (committed.end === 0) committed.end = Math.min(committed.start + minSel, tl.end)
    setRange(committed)
  }

  /* ── 悬停提示（横条：起止·时长·状态） ── */
  const showTip = (e: ReactPointerEvent<HTMLElement>, lines: string[]): void => {
    const rect = e.currentTarget.closest('.canvas-trace')?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = setTimeout(() => setHoverTip({ x, y, lines }), TOOLTIP_DELAY_MS)
  }
  const hideTip = (): void => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = null
    setHoverTip(null)
  }
  useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current) }, [])

  /* ── Inspector 宽度拖拽 ── */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [inspectorW, setInspectorW] = useState(INSPECTOR_DEFAULT_W)
  const gripDrag = useRef<{ pointerId: number; startW: number; startX: number } | null>(null)
  const onGripPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    gripDrag.current = { pointerId: e.pointerId, startW: inspectorW, startX: e.clientX }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onGripPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gripDrag.current
    if (!g || g.pointerId !== e.pointerId) return
    setInspectorW(clamp(g.startW - (e.clientX - g.startX), INSPECTOR_MIN_W, INSPECTOR_MAX_W))
  }

  const nodes = model.nodes
  const pitch = nodes.length <= 8 ? PITCH_MAX : Math.max(PITCH_MIN, Math.floor(PLOT_MAX_H / nodes.length))
  const plotH = Math.max(pitch, nodes.length * pitch)

  const statusLabel = (s: string): string =>
    s === 'done' || s === 'completed'
      ? t('完成')
      : s === 'failed'
        ? t('失败')
        : s === 'running'
          ? t('运行中')
          : s === 'paused' || s === 'awaiting_input'
            ? t('待输入')
            : s

  const kindLabel = (k: TraceRecordKind): string =>
    k === 'thinking'
      ? t('思考')
      : k === 'tool'
        ? t('工具')
        : k === 'tool_result'
          ? t('结果')
          : k === 'error'
            ? t('错误')
            : k === 'user_input'
              ? t('输入')
              : k === 'nodeStart'
                ? t('开始')
                : k === 'nodeEnd'
                  ? t('结束')
                  : k === 'log'
                    ? t('日志')
                    : t('状态')

  const rowText = (r: TraceRecord): string => {
    if (r.kind === 'nodeEnd') {
      const dur = r.detail && r.isError ? `${r.label} · ${r.detail}` : r.label
      return dur
    }
    if (r.kind === 'nodeStart') return r.label
    if ((r.kind === 'tool' || r.kind === 'tool_result') && r.detail) {
      const flat = r.detail.replace(/\s+/g, ' ').trim()
      return `${r.label} → ${flat.length > 72 ? flat.slice(0, 72) + '…' : flat}`
    }
    return r.label
  }

  const timeCol = (r: TraceRecord): string => {
    if (r.atMs == null || model.runStartMs == null) return '—'
    return `+${formatTraceDuration(Math.max(0, r.atMs - model.runStartMs))}`
  }

  const openAll = useCallback((): void => {
    const all: Record<string, boolean> = {}
    for (const n of nodes) all[n.nodeId] = true
    setManualOpen(all)
  }, [nodes])
  const collapseAll = useCallback((): void => setManualOpen({}), [])

  const spansByNode = useMemo(() => new Map(spans.map((s) => [s.nodeId, s])), [spans])

  const selectedRecord = selected?.type === 'record' ? (model.records[selected.index] ?? null) : null
  const selectedLane =
    selected?.type === 'node'
      ? (nodes.find((n) => n.nodeId === selected.nodeId) ?? null)
      : selectedRecord
        ? (nodes.find((n) => n.nodeId === selectedRecord.nodeId) ?? null)
        : null

  return (
    <div className='canvas-trace' ref={rootRef}>
      {/* 工具条：投影模式 + 展开控制 + 框选状态 */}
      <div className='trace-toolbar'>
        <span className='trace-modes' role='group' aria-label={t('时间线投影')}>
          {(['sequence', 'duration', 'actual'] as const).map((m) => (
            <button
              key={m}
              type='button'
              className={`trace-mode-btn${mode === m ? ' active' : ''}`}
              onClick={() => switchMode(m)}
              title={
                m === 'sequence'
                  ? t('按记录顺序等宽排列（无需时间戳）')
                  : m === 'duration'
                    ? t('按执行时长排列，压缩空闲间隙')
                    : t('按墙钟位置排列，并行与等待一目了然')
              }
            >
              {m === 'sequence' ? t('时序') : m === 'duration' ? t('耗时') : t('实际')}
            </button>
          ))}
        </span>
        {degraded ? <span className='trace-degraded'>{t('无时间戳，已降级为时序投影')}</span> : null}
        <span className='trace-toolbar-spacer' />
        {range ? (
          <button type='button' className='trace-tool-btn' onClick={() => setRange(null)}>
            {t('清除框选')}
          </button>
        ) : null}
        <button type='button' className='trace-tool-btn' onClick={openAll}>
          {t('展开全部')}
        </button>
        <button type='button' className='trace-tool-btn' onClick={collapseAll}>
          {t('收起全部')}
        </button>
      </div>

      {tl == null || nodes.length === 0 ? (
        <div className='trace-empty'>{t('暂无轨迹数据')}</div>
      ) : (
        <>
          {/* 时间线概览（节点泳道甘特） */}
          <div
            className='trace-plot'
            style={{ '--trace-pitch': `${pitch}px`, height: `${plotH}px` } as CSSProperties}
          >
            <div className='trace-labels'>
              {nodes.map((n) => (
                <div
                  key={n.nodeId}
                  className='trace-label'
                  onClick={() => setSelected({ type: 'node', nodeId: n.nodeId })}
                  title={n.label}
                >
                  <span className={`trace-label-dot st-${statusClass(n.status)}`} aria-hidden='true' />
                  <span className='trace-label-text'>{n.label}</span>
                </div>
              ))}
            </div>
            <div
              ref={trackRef}
              className='trace-track'
              data-panning={panning || undefined}
              tabIndex={0}
              role='application'
              aria-label={t('节点时间线：拖拽框选过滤台账，滚轮缩放，右键复位')}
              onPointerDown={onTrackPointerDown}
              onPointerMove={onTrackPointerMove}
              onPointerUp={onTrackPointerUp}
              onPointerLeave={hideTip}
              onDoubleClick={resetView}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') resetView()
              }}
            >
              {/* 框选高亮（草稿/已提交） */}
              {(draft ?? range) != null ? (
                <div
                  className='trace-selection'
                  data-draft={draft != null || undefined}
                  style={
                    {
                      left: `${pct((draft ?? range)!.start)}%`,
                      width: `${Math.max(0.2, pct((draft ?? range)!.end) - pct((draft ?? range)!.start))}%`,
                    } as CSSProperties
                  }
                  aria-hidden='true'
                />
              ) : null}
              {/* 运行中 now 游标（诚实：跟随真实时刻） */}
              {running && nowMs != null && nowMs >= domain.start && nowMs <= domain.end ? (
                <div className='trace-now' style={{ left: `${pct(nowMs)}%` }} aria-hidden='true' />
              ) : null}
              {/* 节点段 + 事件刻度 */}
              {tl.spans.map((s) => {
                const lane = nodes[s.lane]
                if (!lane) return null
                const left = pct(s.start)
                const width = Math.max(0.15, pct(s.end) - pct(s.start))
                const ticks = model.records.filter(
                  (r) => r.nodeId === s.nodeId && r.segIdx === s.segIdx && TICK_KINDS.includes(r.kind),
                )
                const segStart = lane.segments[s.segIdx]?.startMs
                const segEnd = lane.segments[s.segIdx]?.endMs
                return (
                  <div
                    key={s.key}
                    className={`trace-span st-${statusClass(s.status)}${s.running ? ' running' : ''}`}
                    style={
                      {
                        top: s.lane * pitch + (pitch - SPAN_H) / 2,
                        height: SPAN_H,
                        left: `${left}%`,
                        width: `${width}%`,
                      } as CSSProperties
                    }
                    data-node-id={s.nodeId}
                    onPointerEnter={(e) => {
                      const lines = [`${lane.label} · ${statusLabel(lane.status)}`]
                      if (segStart != null) {
                        const endTxt = segEnd != null ? formatTraceClock(segEnd) : '…'
                        lines.push(`${formatTraceClock(segStart)} → ${endTxt}`)
                        lines.push(segEnd != null ? formatTraceDuration(segEnd - segStart) : `${t('运行中')} · …`)
                      } else {
                        lines.push(t('时间未知（旧数据）'))
                      }
                      showTip(e, lines)
                    }}
                    onPointerLeave={hideTip}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRange(null)
                      setSelected({ type: 'node', nodeId: s.nodeId })
                    }}
                  >
                    {ticks.map((r) => {
                      const spanDur = Math.max(1, s.end - s.start)
                      const tickLeft = clamp(((tl.recordX[r.index] ?? s.start) - s.start) / spanDur, 0, 1) * 100
                      return (
                        <span
                          key={r.index}
                          className={`trace-tick tk-${r.kind}${r.isError ? ' err' : ''}`}
                          style={{ left: `${tickLeft}%` }}
                          title={rowText(r)}
                        />
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 主体：台账 + Inspector */}
          <div className='trace-body'>
            <div className='trace-ledger' ref={ledgerRef}>
              {nodes.map((lane) => {
                const recs = model.records.filter((r) => r.nodeId === lane.nodeId)
                if (recs.length === 0) return null
                const laneInFocus = focusSet == null || recs.some((r) => focusSet.has(r.index))
                const autoOpen = lane.status === 'running' || lane.status === 'failed'
                const open = lane.nodeId in manualOpen ? manualOpen[lane.nodeId] : autoOpen
                const durTxt =
                  lane.durationMs != null
                    ? formatTraceDuration(lane.durationMs)
                    : lane.segments.some((sg) => sg.endMs == null)
                      ? '—'
                      : lane.segments.length > 0
                        ? formatTraceDuration(
                            lane.segments.reduce(
                              (acc, sg) => acc + Math.max(0, (sg.endMs ?? sg.startMs ?? 0) - (sg.startMs ?? 0)),
                              0,
                            ),
                          )
                        : '—'
                return (
                  <div key={lane.nodeId} className={`trace-node${laneInFocus ? '' : ' dimmed'}`}>
                    <button
                      type='button'
                      className='trace-node-head'
                      aria-expanded={open}
                      onClick={() => setManualOpen((m) => ({ ...m, [lane.nodeId]: !open }))}
                    >
                      <span className={`trace-node-dot st-${statusClass(lane.status)}`} aria-hidden='true' />
                      <span className='trace-node-label'>{lane.label}</span>
                      <span className='trace-node-cmd'>{lane.command}</span>
                      <span className='trace-node-meta tnum'>
                        {statusLabel(lane.status)} · {durTxt} · {recs.length} {t('条记录')}
                      </span>
                      <span className={`trace-node-chev${open ? ' open' : ''}`} aria-hidden='true'>
                        <Icon name='chevronDown' />
                      </span>
                    </button>
                    {open ? (
                      <div className='trace-rows'>
                        {recs.map((r) => {
                          const inFocus = focusSet == null || focusSet.has(r.index)
                          const active = selected?.type === 'record' && selected.index === r.index
                          return (
                            <div
                              key={r.index}
                              data-record-index={r.index}
                              className={`trace-row k-${r.kind}${inFocus ? '' : ' dimmed'}${active ? ' active' : ''}${r.isError ? ' err' : ''}`}
                              onClick={() => setSelected({ type: 'record', index: r.index })}
                            >
                              <span className='trace-row-pill'>
                                <Icon name={kindIcon(r.kind)} />
                                <span className='trace-row-kind'>{kindLabel(r.kind)}</span>
                              </span>
                              <span className='trace-row-text' title={r.detail ?? r.label}>
                                {rowText(r)}
                              </span>
                              <span className='trace-row-time tnum'>{timeCol(r)}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>

            {/* Inspector 侧面板 */}
            <aside className='trace-inspector' style={{ width: inspectorW }}>
              <div
                className='trace-inspector-grip'
                onPointerDown={onGripPointerDown}
                onPointerMove={onGripPointerMove}
                onPointerUp={() => (gripDrag.current = null)}
                onDoubleClick={() => setInspectorW(INSPECTOR_DEFAULT_W)}
                title={t('拖动调整宽度，双击复位')}
                role='separator'
                aria-orientation='vertical'
              />
              {selectedRecord ? (
                <InspectorRecord
                  record={selectedRecord}
                  laneLabel={selectedLane?.label ?? selectedRecord.nodeId}
                  runStartMs={model.runStartMs}
                  onShowNode={() => setSelected({ type: 'node', nodeId: selectedRecord.nodeId })}
                  kindLabel={kindLabel}
                />
              ) : selectedLane ? (
                <InspectorNode
                  lane={selectedLane}
                  span={spansByNode.get(selectedLane.nodeId) ?? null}
                  statusLabel={statusLabel}
                />
              ) : (
                <div className='trace-inspector-empty'>
                  {t('点击时间线横条或台账行查看详情')}
                  <span className='trace-inspector-hint'>
                    {t('拖拽框选可过滤台账，滚轮缩放，右键复位')}
                  </span>
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      {/* 悬停提示 */}
      {hoverTip ? (
        <div
          className='trace-tooltip'
          style={{ left: Math.max(4, hoverTip.x + 12), top: hoverTip.y + 14 }}
          role='tooltip'
        >
          {hoverTip.lines.map((l, i) => (
            <div key={i} className={i === 0 ? 'trace-tooltip-head' : undefined}>
              {l}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ── Inspector：节点（概览/输入/输出/用量） ── */

function InspectorNode({
  lane,
  span,
  statusLabel,
}: {
  lane: TraceNodeLane
  span: RunNodeSpan | null
  statusLabel: (s: string) => string
}): React.ReactElement {
  const { t } = useI18n()
  const [tab, setTab] = useState<'overview' | 'input' | 'output' | 'usage'>('overview')
  useEffect(() => setTab('overview'), [lane.nodeId])

  const text = span ? extractOutputText(span.output) : null
  const badge = span ? formatTokensBadge(span.tokens) : null
  const segments = lane.segments

  return (
    <div className='trace-insp'>
      <div className='trace-insp-head'>
        <span className={`trace-node-dot st-${statusClass(lane.status)}`} aria-hidden='true' />
        <span className='trace-insp-title'>{lane.label}</span>
      </div>
      <div className='trace-insp-tabs' role='tablist'>
        {(
          [
            ['overview', t('概览')],
            ['input', t('输入')],
            ['output', t('输出')],
            ['usage', t('用量')],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type='button'
            role='tab'
            aria-selected={tab === k}
            className={`trace-insp-tab${tab === k ? ' active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className='trace-insp-body'>
        {tab === 'overview' ? (
          <dl className='trace-insp-kv'>
            <dt>{t('状态')}</dt>
            <dd>{statusLabel(lane.status)}</dd>
            <dt>{t('类型')}</dt>
            <dd className='mono'>{lane.command}</dd>
            <dt>{t('开始')}</dt>
            <dd className='mono'>
              {segments[0]?.startMs != null ? formatTraceClock(segments[0]!.startMs!) : '—'}
            </dd>
            <dt>{t('结束')}</dt>
            <dd className='mono'>
              {segments.at(-1)?.endMs != null ? formatTraceClock(segments.at(-1)!.endMs!) : '—'}
            </dd>
            <dt>{t('耗时')}</dt>
            <dd className='mono tnum'>
              {lane.durationMs != null
                ? formatTraceDuration(lane.durationMs)
                : segments.some((s) => s.endMs == null)
                  ? '—'
                  : formatTraceDuration(
                      segments.reduce(
                        (acc, s) => acc + Math.max(0, (s.endMs ?? s.startMs ?? 0) - (s.startMs ?? 0)),
                        0,
                      ),
                    )}
            </dd>
            <dt>{t('执行段数')}</dt>
            <dd className='mono tnum'>{segments.length}</dd>
          </dl>
        ) : null}
        {tab === 'input' ? (
          span?.input != null && Object.keys(span.input as object).length > 0 ? (
            <ResultViewer
              title={`${lane.label} · ${t('输入')}`}
              text={JSON.stringify(span.input, null, 2)}
              mono
            >
              <pre className='trace-insp-pre'>{payloadPreview(span.input)}</pre>
            </ResultViewer>
          ) : (
            <div className='trace-insp-none'>{t('（无输入）')}</div>
          )
        ) : null}
        {tab === 'output' ? (
          text != null ? (
            <ResultViewer title={`${lane.label} · ${t('输出')}`} text={text}>
              <pre className='trace-insp-pre trace-insp-text'>{payloadPreview(text)}</pre>
            </ResultViewer>
          ) : span?.output != null && Object.keys(span.output as object).length > 0 ? (
            <ResultViewer
              title={`${lane.label} · ${t('产出')}`}
              text={JSON.stringify(span.output, null, 2)}
              mono
            >
              <pre className='trace-insp-pre'>{payloadPreview(span.output)}</pre>
            </ResultViewer>
          ) : (
            <div className='trace-insp-none'>{t('（无产出）')}</div>
          )
        ) : null}
        {tab === 'usage' ? (
          <div className='trace-insp-usage'>
            <div className='trace-insp-usage-row'>
              <span>{t('token 用量（输入/输出）')}</span>
              <span className='mono tnum'>{badge ?? '—'}</span>
            </div>
            <div className='trace-insp-usage-row'>
              <span>{t('成本')}</span>
              <span className='mono tnum'>{span?.cost != null ? `$${span.cost.toFixed(4)}` : '—'}</span>
            </div>
            <div className='trace-insp-usage-row'>
              <span>Trace ID</span>
              <span className='mono'>{span?.traceId ?? '—'}</span>
            </div>
          </div>
        ) : null}
        {lane.error ? <div className='trace-insp-error'>{lane.error}</div> : null}
      </div>
    </div>
  )
}

/* ── Inspector：事件（全文 detail + 复制） ── */

function InspectorRecord({
  record,
  laneLabel,
  runStartMs,
  onShowNode,
  kindLabel,
}: {
  record: TraceRecord
  laneLabel: string
  runStartMs: number | null
  onShowNode(): void
  kindLabel: (k: TraceRecordKind) => string
}): React.ReactElement {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    const text = record.detail ?? record.label
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [record])

  return (
    <div className='trace-insp'>
      <div className='trace-insp-head'>
        <span className='trace-row-pill'>
          <Icon name={kindIcon(record.kind)} />
          <span>{kindLabel(record.kind)}</span>
        </span>
        <button type='button' className='trace-insp-nodelink' onClick={onShowNode}>
          {laneLabel} →
        </button>
      </div>
      <div className='trace-insp-body'>
        <div className='trace-insp-recordlabel'>{record.label}</div>
        <div className='trace-insp-time mono tnum'>
          {record.atMs != null
            ? `${formatTraceClock(record.atMs)}${
                runStartMs != null ? ` · +${formatTraceDuration(Math.max(0, record.atMs - runStartMs))}` : ''
              }`
            : '—'}
        </div>
        {record.detail ? (
          <>
            <div className='trace-insp-actions'>
              <button type='button' className='trace-tool-btn' onClick={copy}>
                {copied ? t('已复制') : t('复制')}
              </button>
            </div>
            <ResultViewer title={`${record.label} · ${t('查看全文')}`} text={record.detail} mono>
              <pre className='trace-insp-pre trace-insp-detail'>{record.detail}</pre>
            </ResultViewer>
          </>
        ) : null}
        {record.isError && record.detail ? <div className='trace-insp-error'>{record.detail}</div> : null}
      </div>
    </div>
  )
}
