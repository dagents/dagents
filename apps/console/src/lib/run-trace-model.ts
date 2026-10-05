/**
 * run-trace-model.ts —— 运行轨迹视图的统一投影模型（纯函数，2026-10-01）。
 *
 * 参考 deepseek-harness Trajectory 子系统的「同一事件流、多投影」思想：
 * 与 run-terminal-format 的 TerminalSection **平行**（互不转换）——分别
 * 消化两路数据源、产出同一种 RunTraceModel，轨迹视图（节点泳道时间线 +
 * 事件台账 + Inspector）据此渲染，数据来自直播还是 DB 快照对组件层透明：
 *  - DB 路 buildTraceFromSpans：run_node_spans 行；events 条目 2026-09-06
 *    起带 at（更旧的运行无 at → atMs=null，actual/duration 投影自动缺位，
 *    sequence 投影永远可用）；一行一节点 → 单 segment。
 *  - 直播路 createLiveTraceBuilder：run-live 帧；2026-10-01 起帧带服务端
 *    at（旧网关无 at 用接收时刻兜底）。迭代控制器对同一节点重发 start/
 *    end —— 每次重开记新 segment（同 lane 多段，诚实呈现），与
 *    createLiveSectionBuilder 的「合并 section」语义互补而非矛盾：终端
 *    视图关心「这个节点最终怎么了」，轨迹视图关心「它跑了几程、各在何时」。
 *
 * 投影 deriveTimeline：把 [节点 × segment] 摆上横轴，三种模式 ——
 *  - sequence：台账记录等宽步进（无需时间戳；宽度 = 该段的事件量）
 *  - duration：按记录时长顺排、压缩空闲（「谁耗时最长」）
 *  - actual：墙钟位置（并行分支 / 等待间隙一目了然）
 * 运行中的 segment（endMs=null）由调用方传 nowMs 收口为布局端点——
 * 模型本体不造时长（诚实运行态）。
 */

import type { RunNodeSpan } from '@/lib/node-spans'
import { commandOf, type TerminalLineKind } from '@/lib/run-terminal-format'
import type { RunLiveFrame } from '@dagents/contracts'

/* ── 模型形状 ── */

/** 节点的一段执行区间。endMs=null = 进行中（诚实态，投影时由 nowMs 收口）。 */
export interface TraceSegment {
  startMs: number | null
  endMs: number | null
  /** 开段的 nodeStart（或锚定）台账记录 index —— sequence 投影的段起点。 */
  startRecordIndex: number
  /** 收段的 nodeEnd 记录 index；null = 尚未收口。 */
  endRecordIndex: number | null
}

/** 时间线的一条节点泳道。 */
export interface TraceNodeLane {
  nodeId: string
  label: string
  nodeType: string | null
  status: string
  /** 迭代重跑等多段；DB 路恒为单段。 */
  segments: TraceSegment[]
  /** 累计已知时长（直播路随 nodeEnd 更新；无记录为 null）。 */
  durationMs: number | null
  error: string | null
  /** `$ agent · model-x` 提示行（commandOf 单源）。 */
  command: string
}

/** 台账记录种类：节点边界 + 过程事件（与引擎 IStreamActivityKind 对齐）。 */
export type TraceRecordKind = 'nodeStart' | 'nodeEnd' | TerminalLineKind

/** 台账里的一条记录（时间线的一格 / 台账的一行）。 */
export interface TraceRecord {
  index: number
  nodeId: string
  /** 归属 segment（投影 O(1) 定位用）。 */
  segIdx: number
  kind: TraceRecordKind
  label: string
  detail?: string
  /** 服务端时刻；null = 数据源未记时间（旧运行 events）——sequence 投影
   *  仍可定位（记录序），actual/duration 投影退到段起点。 */
  atMs: number | null
  isError: boolean
  /** nodeEnd 记录的终态（done/failed…）。 */
  status?: string
}

/** 轨迹模型本体：节点泳道 + 台账 + run 边界。 */
export interface RunTraceModel {
  /** 泳道序 = 首次出现序（DB 路为传入 span 序，网关已按 started_at 排）。 */
  nodes: TraceNodeLane[]
  records: TraceRecord[]
  runStartMs: number | null
  /** 直播路收到 runEnd 的时刻；DB 路为 null（run 终态由页面 runState 持有）。 */
  runEndMs: number | null
}

/* ── DB 路：run_node_spans → 模型 ── */

const TRACE_LINE_KINDS: readonly string[] = [
  'thinking',
  'tool',
  'tool_result',
  'status',
  'log',
  'error',
  'user_input',
]

/** span.output.events → 台账记录（宽容解析；旧形状无 at → atMs=null）。 */
function spanEventRecords(
  sp: RunNodeSpan,
): Array<{ kind: TerminalLineKind; label: string; detail?: string; atMs: number | null }> {
  if (!sp.output || typeof sp.output !== 'object') return []
  const raw = (sp.output as Record<string, unknown>).events
  if (!Array.isArray(raw)) return []
  const out: Array<{ kind: TerminalLineKind; label: string; detail?: string; atMs: number | null }> = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const e = r as Record<string, unknown>
    const kind = e.kind
    if (typeof kind !== 'string' || !TRACE_LINE_KINDS.includes(kind)) continue
    const label = typeof e.label === 'string' ? e.label : ''
    if (!label && typeof e.detail !== 'string') continue
    const atMs = typeof e.at === 'string' ? Date.parse(e.at) : null
    out.push({
      kind: kind as TerminalLineKind,
      label,
      ...(typeof e.detail === 'string' && e.detail ? { detail: e.detail } : {}),
      atMs: atMs != null && Number.isFinite(atMs) ? atMs : null,
    })
  }
  return out
}

/** DB 快照 → 轨迹模型。span 序即泳道序（网关按 started_at 升序返回）。 */
export function buildTraceFromSpans(spans: RunNodeSpan[]): RunTraceModel {
  const nodes: TraceNodeLane[] = []
  const records: TraceRecord[] = []
  let runStartMs: number | null = null

  // 先逐 span 造 lane + 收集记录（相对序），再全局稳定排序赋 index。
  // fallbackMs：无 at 记录的排序锚（本 span 终点，退起点）。
  const pending: Array<{
    atMs: number | null
    fallbackMs: number | null
    order: number
    make: (index: number) => void
  }> = []
  spans.forEach((sp, spanIdx) => {
    const nodeId = sp.nodeId || '?'
    const startedAt = sp.startedAt ? Date.parse(sp.startedAt) : null
    const finishedAt = sp.finishedAt ? Date.parse(sp.finishedAt) : null
    const startMs = startedAt != null && Number.isFinite(startedAt) ? startedAt : null
    const endMs = finishedAt != null && Number.isFinite(finishedAt) ? finishedAt : null
    const status = sp.status ?? 'unknown'
    const lane: TraceNodeLane = {
      nodeId,
      label: sp.nodeLabel || nodeId,
      nodeType: sp.nodeType,
      status,
      segments: [],
      durationMs: sp.durationMs ?? null,
      error: sp.error ?? null,
      command: commandOf(sp.nodeType, sp.input, sp.nodeLabel),
    }
    nodes.push(lane)
    if (startMs != null) runStartMs = runStartMs == null ? startMs : Math.min(runStartMs, startMs)

    // nodeStart 记录锚定 segment；事件随其后；终态 nodeEnd 记录收口。
    const segIdx = 0
    let anchor = -1
    pending.push({
      atMs: startMs,
      fallbackMs: endMs ?? startMs,
      order: spanIdx * 10000,
      make: (index) => {
        anchor = index
        records.push({
          index,
          nodeId,
          segIdx,
          kind: 'nodeStart',
          label: lane.label,
          atMs: startMs,
          isError: false,
        })
      },
    })
    let eventSeq = 0
    for (const ev of spanEventRecords(sp)) {
      const seq = eventSeq++
      pending.push({
        atMs: ev.atMs,
        fallbackMs: endMs ?? startMs,
        order: spanIdx * 10000 + 1 + seq,
        make: (index) => {
          records.push({
            index,
            nodeId,
            segIdx,
            kind: ev.kind,
            label: ev.label,
            ...(ev.detail ? { detail: ev.detail } : {}),
            atMs: ev.atMs,
            isError: ev.kind === 'error',
          })
        },
      })
    }
    if (status === 'done' || status === 'failed' || status === 'completed') {
      const error = sp.error ?? null
      pending.push({
        atMs: endMs,
        fallbackMs: endMs ?? startMs,
        order: spanIdx * 10000 + 9000,
        make: (index) => {
          records.push({
            index,
            nodeId,
            segIdx,
            kind: 'nodeEnd',
            label: lane.label,
            atMs: endMs,
            isError: status === 'failed',
            status,
            ...(error ? { detail: error } : {}),
          })
          lane.segments[0] = {
            startMs,
            endMs,
            startRecordIndex: anchor,
            endRecordIndex: index,
          }
        },
      })
    }
    // 非终态（running/paused…）：segment 开着，锚点在 nodeStart 落位后补。
    pending.push({
      atMs: endMs,
      fallbackMs: endMs ?? startMs,
      order: spanIdx * 10000 + 9500,
      make: () => {
        if (lane.segments.length === 0) {
          lane.segments[0] = { startMs, endMs, startRecordIndex: anchor, endRecordIndex: null }
        }
      },
    })
  })

  // 稳定排序：有时刻按时刻；无时刻（旧运行 events）借用本 span 的
  // finishedAt/startedAt 作排序键——贴着本节点区间、先于 nodeEnd，
  // 不全局沉底（atMs 本体保持 null，投影诚实不造时刻）。
  const sorted = pending
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ta = a.p.atMs ?? a.p.fallbackMs ?? Number.POSITIVE_INFINITY
      const tb = b.p.atMs ?? b.p.fallbackMs ?? Number.POSITIVE_INFINITY
      if (ta !== tb) return ta - tb
      return a.p.order - b.p.order || a.i - b.i
    })
  sorted.forEach(({ p }, idx) => p.make(idx))

  return { nodes, records, runStartMs, runEndMs: null }
}

/* ── 直播路：run-live 帧 → 模型（增量构建器） ── */

export interface LiveTraceBuilder {
  push(frame: RunLiveFrame): void
  model(): RunTraceModel
}

const atOf = (frame: RunLiveFrame): number => {
  const raw = (frame as { at?: string }).at
  const ms = raw ? Date.parse(raw) : NaN
  return Number.isFinite(ms) ? ms : Date.now()
}

/** 与 createLiveSectionBuilder 同构：吃帧流、产出 RunTraceModel。 */
export function createLiveTraceBuilder(): LiveTraceBuilder {
  const byId = new Map<string, TraceNodeLane>()
  const order: string[] = []
  const records: TraceRecord[] = []
  let runStartMs: number | null = null
  let runEndMs: number | null = null
  let pendingTruncationNote: string | null = null

  const laneOf = (nodeId: string, nodeName: string, nodeType?: string | null): TraceNodeLane => {
    let lane = byId.get(nodeId)
    if (!lane) {
      lane = {
        nodeId,
        label: nodeName || nodeId,
        nodeType: nodeType ?? null,
        status: 'running',
        segments: [],
        durationMs: null,
        error: null,
        command: commandOf(nodeType ?? null, null, nodeName),
      }
      byId.set(nodeId, lane)
      order.push(nodeId)
      if (pendingTruncationNote) {
        records.push({
          index: records.length,
          nodeId,
          segIdx: 0,
          kind: 'status',
          label: pendingTruncationNote,
          atMs: null,
          isError: false,
        })
        pendingTruncationNote = null
      }
    }
    return lane
  }

  /** 当前开段（末段未收口）；无则按锚点时刻补开一段（nodeStart 被截断等）。 */
  const openSegment = (lane: TraceNodeLane, atMs: number, recordIndex: number): TraceSegment => {
    const last = lane.segments[lane.segments.length - 1]
    if (last && last.endMs == null) return last
    const seg: TraceSegment = {
      startMs: atMs,
      endMs: null,
      startRecordIndex: recordIndex,
      endRecordIndex: null,
    }
    lane.segments.push(seg)
    return seg
  }

  return {
    push(frame: RunLiveFrame): void {
      const atMs = atOf(frame)
      if (runStartMs == null) runStartMs = atMs

      if (frame.type === 'nodeStart') {
        const lane = laneOf(frame.nodeId, frame.nodeName, frame.nodeType)
        if (lane.nodeType == null && frame.nodeType != null) lane.nodeType = frame.nodeType
        lane.status = 'running'
        records.push({
          index: records.length,
          nodeId: lane.nodeId,
          segIdx: lane.segments.length,
          kind: 'nodeStart',
          label: lane.label,
          atMs,
          isError: false,
        })
        lane.segments.push({
          startMs: atMs,
          endMs: null,
          startRecordIndex: records.length - 1,
          endRecordIndex: null,
        })
        return
      }
      if (frame.type === 'nodeEnd') {
        const lane = laneOf(frame.nodeId, frame.nodeName)
        lane.status = frame.status
        lane.error = frame.error ?? null
        const seg = openSegment(lane, atMs, records.length)
        const segIdx = lane.segments.length - 1
        seg.endMs = atMs
        records.push({
          index: records.length,
          nodeId: lane.nodeId,
          segIdx,
          kind: 'nodeEnd',
          label: lane.label,
          atMs,
          isError: frame.status === 'failed',
          status: frame.status,
          ...(frame.error ? { detail: frame.error } : {}),
        })
        seg.endRecordIndex = records.length - 1
        // 累计时长：帧带 durationMs（末段）时加上先前段；否则按段区间求和。
        if (frame.durationMs != null) {
          const priorMs = lane.segments
            .slice(0, -1)
            .reduce((acc, s) => acc + Math.max(0, (s.endMs ?? s.startMs ?? 0) - (s.startMs ?? 0)), 0)
          lane.durationMs = priorMs + frame.durationMs
        } else {
          lane.durationMs = lane.segments.reduce(
            (acc, s) => acc + Math.max(0, (s.endMs ?? s.startMs ?? 0) - (s.startMs ?? 0)),
            0,
          )
        }
        return
      }
      if (frame.type === 'delta') {
        if (frame.delta.type === 'text') return // 正文不进台账（Inspector/摘要视图呈现）
        const lane = laneOf(frame.nodeId, frame.nodeName)
        openSegment(lane, atMs, records.length)
        const known = TRACE_LINE_KINDS.includes(frame.delta.kind)
        records.push({
          index: records.length,
          nodeId: lane.nodeId,
          segIdx: lane.segments.length - 1,
          kind: known ? (frame.delta.kind as TerminalLineKind) : 'log',
          label: frame.delta.label,
          ...(frame.delta.detail ? { detail: frame.delta.detail } : {}),
          atMs,
          isError: frame.delta.kind === 'error',
        })
        return
      }
      if (frame.type === 'runEnd') {
        runEndMs = atMs
        return
      }
      if (frame.type === 'truncated') {
        const note = `…（更早的 ${frame.dropped} 帧超出回放上限被截断）`
        if (order.length > 0) {
          records.push({
            index: records.length,
            nodeId: order[0]!,
            segIdx: 0,
            kind: 'status',
            label: note,
            atMs: null,
            isError: false,
          })
        } else {
          pendingTruncationNote = note
        }
      }
    },
    model(): RunTraceModel {
      return {
        nodes: order.map((id) => byId.get(id) as TraceNodeLane),
        records,
        runStartMs,
        runEndMs,
      }
    },
  }
}

/* ── 投影：模型 → 时间线横轴 ── */

export type TraceTimelineMode = 'sequence' | 'duration' | 'actual'

/** 投影后的一条节点段（横轴区间 + 泳道行号）。 */
export interface TraceTimelineSpan {
  key: string
  nodeId: string
  segIdx: number
  lane: number
  start: number
  end: number
  status: string
  running: boolean
  error: string | null
}

export interface TraceTimelineModel {
  start: number
  end: number
  spans: TraceTimelineSpan[]
  /** 与 trace.records 对齐的横轴坐标（框选过滤/滚动定位用）。 */
  recordX: number[]
}

/** 开段布局端点：模型不造时长，投影收口由 nowMs 提供（运行中随心跳延伸）。 */
const layoutEnd = (seg: TraceSegment, nowMs: number | null): number | null =>
  seg.endMs ?? nowMs

/**
 * 投影模型 → 时间线。返回 null = 无可摆内容（空模型）。
 * 三模式见文件头；actual 需要绝对时刻（缺时刻的段被跳过——诚实优于错位）。
 */
export function deriveTimeline(
  trace: RunTraceModel,
  mode: TraceTimelineMode = 'sequence',
  nowMs: number | null = null,
): TraceTimelineModel | null {
  if (trace.nodes.length === 0) return null

  if (mode === 'sequence') {
    const total = trace.records.length
    const spans: TraceTimelineSpan[] = []
    trace.nodes.forEach((lane, laneIdx) => {
      lane.segments.forEach((seg, segIdx) => {
        // 锚点缺失的旧数据（startedAt 缺席）锚可能为 -1 —— 钳到 0，不产负坐标。
        const start = Math.max(0, seg.startRecordIndex)
        const end = Math.max(start + 1, seg.endRecordIndex != null ? seg.endRecordIndex + 1 : total)
        spans.push({
          key: `${lane.nodeId}#${segIdx}`,
          nodeId: lane.nodeId,
          segIdx,
          lane: laneIdx,
          start,
          end,
          status: lane.status,
          running: seg.endMs == null,
          error: lane.error,
        })
      })
    })
    if (spans.length === 0) return null
    return {
      start: 0,
      end: Math.max(1, total),
      spans,
      recordX: trace.records.map((_, i) => i + 0.5),
    }
  }

  if (mode === 'actual') {
    const spans: TraceTimelineSpan[] = []
    trace.nodes.forEach((lane, laneIdx) => {
      lane.segments.forEach((seg, segIdx) => {
        const s = seg.startMs
        const e = layoutEnd(seg, nowMs)
        if (s == null || e == null || e < s) return
        spans.push({
          key: `${lane.nodeId}#${segIdx}`,
          nodeId: lane.nodeId,
          segIdx,
          lane: laneIdx,
          start: s,
          end: e,
          status: lane.status,
          running: seg.endMs == null,
          error: lane.error,
        })
      })
    })
    if (spans.length === 0) return null
    const start = Math.min(...spans.map((s) => s.start))
    const end = Math.max(...spans.map((s) => s.end))
    return {
      start,
      end: Math.max(end, start + 1),
      spans,
      recordX: projectRecords(trace, spans, mode, nowMs),
    }
  }

  // duration：段宽 = 已知时长（开段用 nowMs 收口），按段起点时刻顺排、压缩空闲。
  const ordered: Array<{ seg: TraceSegment; laneIdx: number; nodeId: string; segIdx: number }> = []
  trace.nodes.forEach((lane, laneIdx) => {
    lane.segments.forEach((seg, segIdx) => {
      ordered.push({ seg, laneIdx, nodeId: lane.nodeId, segIdx })
    })
  })
  if (ordered.length === 0) return null
  const byStart = [...ordered].sort((a, b) => (a.seg.startMs ?? 0) - (b.seg.startMs ?? 0))
  const widthOf = (seg: TraceSegment): number => {
    const s = seg.startMs
    const e = layoutEnd(seg, nowMs)
    return s != null && e != null ? Math.max(1, e - s) : 1
  }
  const cursorAt = new Map<TraceSegment, number>()
  let cursor = 0
  for (const item of byStart) {
    cursorAt.set(item.seg, cursor)
    cursor += widthOf(item.seg)
  }
  const spans: TraceTimelineSpan[] = ordered.map((item) => {
    const x = cursorAt.get(item.seg) ?? 0
    return {
      key: `${item.nodeId}#${item.segIdx}`,
      nodeId: item.nodeId,
      segIdx: item.segIdx,
      lane: item.laneIdx,
      start: x,
      end: x + widthOf(item.seg),
      status: trace.nodes[item.laneIdx]!.status,
      running: item.seg.endMs == null,
      error: trace.nodes[item.laneIdx]!.error,
    }
  })
  const recordX = projectRecords(trace, spans, mode, nowMs)
  return { start: 0, end: Math.max(1, cursor), spans, recordX }
}

/** 点事件（activity/nodeStart/nodeEnd）在段投影区间内的相对落点。 */
function projectRecords(
  trace: RunTraceModel,
  spans: TraceTimelineSpan[],
  mode: TraceTimelineMode,
  nowMs: number | null,
): number[] {
  const spanByKey = new Map(spans.map((s) => [s.key, s]))
  return trace.records.map((rec) => {
    const lane = trace.nodes.find((n) => n.nodeId === rec.nodeId)
    const seg = lane?.segments[rec.segIdx]
    const proj = seg ? spanByKey.get(`${rec.nodeId}#${rec.segIdx}`) : undefined
    if (!proj || !seg) return proj?.start ?? 0
    if (rec.kind === 'nodeStart') return proj.start
    if (rec.kind === 'nodeEnd') return proj.end
    if (rec.atMs == null || seg.startMs == null) return proj.start
    const segEndMs = layoutEnd(seg, nowMs)
    if (segEndMs == null || segEndMs <= seg.startMs) return proj.start
    const frac = Math.min(1, Math.max(0, (rec.atMs - seg.startMs) / (segEndMs - seg.startMs)))
    return proj.start + frac * (proj.end - proj.start)
  })
}

/** 框选区间 → 命中的台账记录 index 集合（区间外由组件 dim）。 */
export function timelineFocusIndexes(
  trace: RunTraceModel,
  range: { start: number; end: number },
  mode: TraceTimelineMode = 'sequence',
  nowMs: number | null = null,
): ReadonlySet<number> {
  const model = deriveTimeline(trace, mode, nowMs)
  if (model == null) return new Set()
  const hits = new Set<number>()
  model.recordX.forEach((x, i) => {
    if (x >= range.start && x <= range.end) hits.add(i)
  })
  return hits
}

/* ── 展示格式化（tooltip/时间列共用） ── */

/** 时刻 → HH:MM:SS.mmm（dsh TrajectoryTimeline 同款）。 */
export function formatTraceClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

/** 时长 → 紧凑单行（1.2s / 45.0s / 2m03s / 1h04m）。 */
export function formatTraceDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${m}m${String(s).padStart(2, '0')}s`
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return `${h}h${String(m).padStart(2, '0')}m`
}
