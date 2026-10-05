import { describe, it, expect } from 'vitest'
import type { RunNodeSpan } from '@/lib/node-spans'
import type { RunLiveFrame } from '@dagents/contracts'
import {
  buildTraceFromSpans,
  createLiveTraceBuilder,
  deriveTimeline,
  timelineFocusIndexes,
  formatTraceDuration,
} from '@/lib/run-trace-model'

/**
 * run-trace-model（轨迹视图投影层）测试：
 *  - DB 路 / 直播路 → 同一 RunTraceModel 形状（节点泳道 + 台账记录）。
 *  - 三投影（sequence/duration/actual）的横轴数值语义。
 *  - 诚实运行态：开段 endMs=null，投影由 nowMs 收口。
 *  - 直播与回放一致性：同一执行两种数据源产出等价模型。
 */

const T0 = Date.parse('2026-10-01T10:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function span(p: Partial<RunNodeSpan> & { nodeId: string }): RunNodeSpan {
  return {
    nodeId: p.nodeId,
    nodeLabel: p.nodeLabel ?? null,
    nodeType: p.nodeType ?? 'llmAgentflow',
    status: p.status ?? 'done',
    error: p.error ?? null,
    startedAt: p.startedAt ?? null,
    finishedAt: p.finishedAt ?? null,
    durationMs: p.durationMs ?? null,
    tokens: p.tokens ?? null,
    cost: p.cost ?? null,
    traceId: p.traceId ?? null,
    input: p.input ?? null,
    output: p.output ?? null,
  }
}

describe('buildTraceFromSpans（DB 路）', () => {
  it('终态 span → 单段 lane + nodeStart/events/nodeEnd 记录', () => {
    const trace = buildTraceFromSpans([
      span({
        nodeId: 'n1',
        nodeLabel: '写作',
        status: 'done',
        startedAt: iso(T0),
        finishedAt: iso(T0 + 4000),
        durationMs: 4000,
        output: {
          events: [
            { kind: 'thinking', label: '思考中', at: iso(T0 + 100) },
            { kind: 'tool', label: 'bash', detail: '{"cmd":"ls"}', at: iso(T0 + 200) },
          ],
        },
      }),
    ])
    expect(trace.nodes).toHaveLength(1)
    const lane = trace.nodes[0]!
    expect(lane.segments).toHaveLength(1)
    expect(lane.segments[0]!.startMs).toBe(T0)
    expect(lane.segments[0]!.endMs).toBe(T0 + 4000)
    expect(lane.status).toBe('done')
    expect(lane.command).toBe('$ llm')
    expect(trace.records.map((r) => r.kind)).toEqual([
      'nodeStart',
      'thinking',
      'tool',
      'nodeEnd',
    ])
    expect(trace.records.map((r) => r.index)).toEqual([0, 1, 2, 3])
    expect(trace.records[2]!.detail).toBe('{"cmd":"ls"}')
    expect(trace.runStartMs).toBe(T0)
  })

  it('多节点按时刻全局排序（跨 span 交错）', () => {
    const trace = buildTraceFromSpans([
      span({ nodeId: 'a', startedAt: iso(T0), finishedAt: iso(T0 + 1000), status: 'done' }),
      span({ nodeId: 'b', startedAt: iso(T0 + 500), finishedAt: iso(T0 + 900), status: 'done' }),
    ])
    expect(trace.records.map((r) => r.nodeId)).toEqual(['a', 'b', 'b', 'a'])
    expect(trace.records.map((r) => r.kind)).toEqual(['nodeStart', 'nodeStart', 'nodeEnd', 'nodeEnd'])
  })

  it('运行中 span → 开段（endMs=null，诚实态）', () => {
    const trace = buildTraceFromSpans([
      span({ nodeId: 'n1', status: 'running', startedAt: iso(T0) }),
    ])
    const seg = trace.nodes[0]!.segments[0]!
    expect(seg.endMs).toBeNull()
    expect(seg.endRecordIndex).toBeNull()
    expect(trace.records.map((r) => r.kind)).toEqual(['nodeStart'])
  })

  it('旧运行 events 无 at → atMs=null，记录保持产生序', () => {
    const trace = buildTraceFromSpans([
      span({
        nodeId: 'n1',
        status: 'done',
        startedAt: iso(T0),
        finishedAt: iso(T0 + 1000),
        output: {
          events: [
            { kind: 'status', label: 'first' },
            { kind: 'log', label: 'second' },
          ],
        },
      }),
    ])
    const evts = trace.records.filter((r) => r.kind !== 'nodeStart' && r.kind !== 'nodeEnd')
    expect(evts.map((r) => r.label)).toEqual(['first', 'second'])
    expect(evts.every((r) => r.atMs === null)).toBe(true)
    // 无时刻记录沉底但先于 nodeEnd（nodeEnd 有 finishedAt 时刻）
    expect(trace.records.map((r) => r.kind)).toEqual(['nodeStart', 'status', 'log', 'nodeEnd'])
  })

  it('失败 span → nodeEnd 记录带 error detail 与 isError', () => {
    const trace = buildTraceFromSpans([
      span({ nodeId: 'n1', status: 'failed', error: 'boom', startedAt: iso(T0), finishedAt: iso(T0 + 50) }),
    ])
    const end = trace.records.at(-1)!
    expect(end.kind).toBe('nodeEnd')
    expect(end.isError).toBe(true)
    expect(end.status).toBe('failed')
    expect(end.detail).toBe('boom')
  })
})

describe('createLiveTraceBuilder（直播路）', () => {
  const frames = (...fs: RunLiveFrame[]): RunLiveFrame[] => fs

  it('帧流 → 泳道 + 记录；text 增量不进台账', () => {
    const b = createLiveTraceBuilder()
    for (const f of frames(
      { type: 'nodeStart', nodeId: 'n1', nodeName: 'A', nodeType: 'llmAgentflow', at: iso(T0) },
      { type: 'delta', nodeId: 'n1', nodeName: 'A', delta: { type: 'text', text: 'hi' }, at: iso(T0 + 10) },
      {
        type: 'delta',
        nodeId: 'n1',
        nodeName: 'A',
        delta: { type: 'activity', kind: 'tool', label: 'bash', detail: '{"cmd":"ls"}' },
        at: iso(T0 + 20),
      },
      { type: 'nodeEnd', nodeId: 'n1', nodeName: 'A', status: 'done', durationMs: 2000, at: iso(T0 + 2000) },
      { type: 'runEnd', status: 'completed', at: iso(T0 + 2100) },
    )) {
      b.push(f)
    }
    const m = b.model()
    expect(m.nodes).toHaveLength(1)
    expect(m.nodes[0]!.durationMs).toBe(2000)
    expect(m.records.map((r) => r.kind)).toEqual(['nodeStart', 'tool', 'nodeEnd'])
    expect(m.runStartMs).toBe(T0)
    expect(m.runEndMs).toBe(T0 + 2100)
  })

  it('迭代重跑：同 lane 多段，各自收口', () => {
    const b = createLiveTraceBuilder()
    for (const f of frames(
      { type: 'nodeStart', nodeId: 'n1', nodeName: 'A', at: iso(T0) },
      { type: 'nodeEnd', nodeId: 'n1', nodeName: 'A', status: 'done', durationMs: 1000, at: iso(T0 + 1000) },
      { type: 'nodeStart', nodeId: 'n1', nodeName: 'A', at: iso(T0 + 2000) },
      { type: 'nodeEnd', nodeId: 'n1', nodeName: 'A', status: 'done', durationMs: 500, at: iso(T0 + 2500) },
    )) {
      b.push(f)
    }
    const m = b.model()
    expect(m.nodes).toHaveLength(1)
    const segs = m.nodes[0]!.segments
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ startMs: T0, endMs: T0 + 1000 })
    expect(segs[1]).toMatchObject({ startMs: T0 + 2000, endMs: T0 + 2500 })
    expect(m.nodes[0]!.durationMs).toBe(1500)
    // 记录 segIdx 指向各自段
    expect(m.records.map((r) => r.segIdx)).toEqual([0, 0, 1, 1])
  })

  it('truncated 首达 → 挂起为首 lane 的 status 记录；未知 kind 降级 log', () => {
    const b = createLiveTraceBuilder()
    b.push({ type: 'truncated', dropped: 7 })
    b.push({
      type: 'delta',
      nodeId: 'n1',
      nodeName: 'A',
      delta: { type: 'activity', kind: 'future-kind', label: 'x' },
      at: iso(T0),
    })
    const m = b.model()
    expect(m.records[0]!.kind).toBe('status')
    expect(m.records[0]!.label).toContain('7')
    expect(m.records[1]!.kind).toBe('log')
    // 无 nodeStart 的首帧 → 补 lane + 开段（锚定最早已知点）
    expect(m.nodes[0]!.segments[0]!.startMs).toBe(T0)
  })

  it('nodeEnd 无开段（回放截断）→ 补零宽段锚定 lane', () => {
    const b = createLiveTraceBuilder()
    b.push({ type: 'nodeEnd', nodeId: 'n1', nodeName: 'A', status: 'failed', error: 'x', at: iso(T0 + 100) })
    const m = b.model()
    expect(m.nodes[0]!.status).toBe('failed')
    expect(m.nodes[0]!.segments[0]!.endMs).toBe(T0 + 100)
  })

  it('帧无 at（旧网关）→ 接收时刻兜底，atMs 非 null', () => {
    const b = createLiveTraceBuilder()
    b.push({ type: 'nodeStart', nodeId: 'n1', nodeName: 'A' })
    const m = b.model()
    expect(m.records[0]!.atMs).not.toBeNull()
  })
})

describe('deriveTimeline（三投影）', () => {
  const trace = buildTraceFromSpans([
    span({
      nodeId: 'a',
      status: 'done',
      startedAt: iso(T0),
      finishedAt: iso(T0 + 1000),
      durationMs: 1000,
      output: { events: [{ kind: 'tool', label: 't1', at: iso(T0 + 500) }] },
    }),
    span({ nodeId: 'b', status: 'done', startedAt: iso(T0 + 3000), finishedAt: iso(T0 + 4000), durationMs: 1000 }),
  ])

  it('sequence：记录等宽步进，段界跨记录序', () => {
    const tl = deriveTimeline(trace, 'sequence')!
    expect(tl.start).toBe(0)
    expect(tl.end).toBe(5) // a: start,tool,end + b: start,end
    const a = tl.spans.find((s) => s.nodeId === 'a')!
    expect(a.start).toBe(0)
    expect(a.end).toBe(3)
    expect(tl.recordX).toEqual([0.5, 1.5, 2.5, 3.5, 4.5])
  })

  it('duration：段宽 = 时长、空闲压缩（2s 间隙消失）', () => {
    const tl = deriveTimeline(trace, 'duration')!
    const a = tl.spans.find((s) => s.nodeId === 'a')!
    const b = tl.spans.find((s) => s.nodeId === 'b')!
    expect(a.start).toBe(0)
    expect(a.end).toBe(1000)
    expect(b.start).toBe(1000) // T0+3000..T0+4000 的 2s 间隙被压掉
    expect(b.end).toBe(2000)
  })

  it('actual：墙钟位置（含间隙与并行）', () => {
    const tl = deriveTimeline(trace, 'actual')!
    const a = tl.spans.find((s) => s.nodeId === 'a')!
    const b = tl.spans.find((s) => s.nodeId === 'b')!
    expect(a.start).toBe(T0)
    expect(b.start).toBe(T0 + 3000)
    expect(tl.start).toBe(T0)
    expect(tl.end).toBe(T0 + 4000)
  })

  it('运行中段由 nowMs 收口（模型本体保持 endMs=null）', () => {
    const running = buildTraceFromSpans([span({ nodeId: 'a', status: 'running', startedAt: iso(T0) })])
    expect(running.nodes[0]!.segments[0]!.endMs).toBeNull()
    const tl = deriveTimeline(running, 'actual', T0 + 2500)!
    const a = tl.spans.find((s) => s.nodeId === 'a')!
    expect(a.end).toBe(T0 + 2500)
    expect(a.running).toBe(true)
  })

  it('无任何时刻（旧运行 actual 请求）→ null，由调用方降级 sequence', () => {
    const legacy = buildTraceFromSpans([span({ nodeId: 'a', status: 'done', startedAt: null, finishedAt: null })])
    expect(deriveTimeline(legacy, 'actual')).toBeNull()
    expect(deriveTimeline(legacy, 'sequence')).not.toBeNull()
  })

  it('recordX：actual 模式事件按时刻落入段区间内', () => {
    const tl = deriveTimeline(trace, 'actual')!
    const toolRec = trace.records.find((r) => r.kind === 'tool')!
    const x = tl.recordX[toolRec.index]!
    const a = tl.spans.find((s) => s.nodeId === 'a')!
    expect(x).toBeGreaterThan(a.start)
    expect(x).toBeLessThan(a.end)
  })
})

describe('timelineFocusIndexes + 格式化', () => {
  it('框选区间命中区间内记录', () => {
    const trace = buildTraceFromSpans([
      span({
        nodeId: 'a',
        status: 'done',
        startedAt: iso(T0),
        finishedAt: iso(T0 + 1000),
        output: {
          events: [
            { kind: 'tool', label: 't1', at: iso(T0 + 100) },
            { kind: 'tool', label: 't2', at: iso(T0 + 500) },
            { kind: 'tool', label: 't3', at: iso(T0 + 900) },
          ],
        },
      }),
    ])
    const hits = timelineFocusIndexes(trace, { start: T0 + 400, end: T0 + 600 }, 'actual')
    const labels = trace.records.filter((r) => hits.has(r.index)).map((r) => r.label)
    expect(labels).toEqual(['t2'])
  })

  it('formatTraceDuration 分档', () => {
    expect(formatTraceDuration(120)).toBe('120ms')
    expect(formatTraceDuration(1234)).toBe('1.2s')
    expect(formatTraceDuration(63_000)).toBe('1m03s')
    expect(formatTraceDuration(3_900_000)).toBe('1h05m')
  })
})

describe('直播与回放一致性（同一执行两路数据源）', () => {
  it('frames 序列与 spans 快照产出等价泳道/段界/记录种类', () => {
    const spans = [
      span({
        nodeId: 'n1',
        nodeLabel: 'A',
        nodeType: 'platformAgent',
        status: 'done',
        startedAt: iso(T0),
        finishedAt: iso(T0 + 3000),
        durationMs: 3000,
        output: {
          events: [
            { kind: 'thinking', label: '想', at: iso(T0 + 100) },
            { kind: 'tool', label: 'bash', detail: '{}', at: iso(T0 + 1500) },
          ],
        },
      }),
    ]
    const fromSpans = buildTraceFromSpans(spans)

    const b = createLiveTraceBuilder()
    for (const f of [
      { type: 'nodeStart', nodeId: 'n1', nodeName: 'A', nodeType: 'platformAgent', at: iso(T0) },
      { type: 'delta', nodeId: 'n1', nodeName: 'A', delta: { type: 'activity', kind: 'thinking', label: '想' }, at: iso(T0 + 100) },
      { type: 'delta', nodeId: 'n1', nodeName: 'A', delta: { type: 'activity', kind: 'tool', label: 'bash', detail: '{}' }, at: iso(T0 + 1500) },
      { type: 'nodeEnd', nodeId: 'n1', nodeName: 'A', status: 'done', durationMs: 3000, at: iso(T0 + 3000) },
    ] as RunLiveFrame[]) {
      b.push(f)
    }
    const fromLive = b.model()

    expect(fromLive.nodes.map((n) => [n.nodeId, n.status])).toEqual(
      fromSpans.nodes.map((n) => [n.nodeId, n.status]),
    )
    expect(fromLive.nodes[0]!.segments[0]).toMatchObject({
      startMs: fromSpans.nodes[0]!.segments[0]!.startMs,
      endMs: fromSpans.nodes[0]!.segments[0]!.endMs,
    })
    expect(fromLive.records.map((r) => r.kind)).toEqual(fromSpans.records.map((r) => r.kind))
    expect(fromLive.records.map((r) => r.atMs)).toEqual(fromSpans.records.map((r) => r.atMs))
  })
})
