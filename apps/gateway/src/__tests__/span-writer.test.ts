import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeIncrementalSpanWriter } from '../span-writer.js'
import type { IExecutedNode } from '@dagents/workflow'

const mockRunQuery = vi.fn()

vi.mock('@dagents/db', () => ({
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
}))

/** delta 路径的 UPDATE 载荷（output JSON）。 */
function deltaPayloads(): Array<Record<string, unknown>> {
  return mockRunQuery.mock.calls
    .filter((call) => {
      const sql = String(call[0])
      return sql.startsWith('UPDATE run_node_spans') && sql.includes('SET output')
    })
    .map((call) => JSON.parse(String((call[1] as unknown[])[0])) as Record<string, unknown>)
}

/** 排干 onNodeStart/onNodeEnd 的 promise 链（enqueue 是微任务串行）。 */
async function flushWrites(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** 终态 upsert 的 output 载荷（INSERT 参数第 13 位；取最后一条 ——
 *  onNodeStart 的 running 行也是同款 upsert 且 output 为 null）。 */
function finalOutput(): Record<string, unknown> | null {
  const call = mockRunQuery.mock.calls
    .filter((c) => String(c[0]).includes('ON CONFLICT (run_id, node_id)'))
    .at(-1)
  if (!call) return null
  const raw = (call[1] as unknown[])[12]
  return raw == null ? null : (JSON.parse(String(raw)) as Record<string, unknown>)
}

function makeWriter() {
  return makeIncrementalSpanWriter({
    runId: '00000000-0000-0000-0000-000000000001',
    flowId: '00000000-0000-0000-0000-000000000002',
    nodeLabelById: new Map([['n1', '规划']]),
    nodeTypeById: new Map([['n1', 'platformAgent']]),
    log: { warn: vi.fn() },
  })
}

const node = { nodeId: 'n1', nodeName: '规划' }

/** 推进时间并补一个 text delta，强制一次「带 events」的落库
 *  （首个 delta 在 t=0 立即触发首轮落库且只含已缓冲条目；events 的
 *  慢节拍要距上次 events 刷 ≥5s）。 */
const triggerEventsFlush = (w: ReturnType<typeof makeWriter>, ms: number): void => {
  vi.setSystemTime(new Date('2026-09-06T10:00:00Z').getTime() + ms)
  w.onNodeDelta(node, { type: 'text', text: ' ' })
}

describe('span-writer 过程事件保真（2026-09-06 终端视图裁决）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunQuery.mockResolvedValue({ records: [], affected: 1 })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('thinking 全文 / 工具参数全文 / 工具输出全文进 events —— 采集端不截断', () => {
    const w = makeWriter()
    w.onNodeStart(node)
    const thinking = '深'.repeat(500)
    const toolArgs = JSON.stringify({ command: 'x'.repeat(5000) })
    const toolOutput = 'o'.repeat(8000)
    w.onNodeDelta(node, { type: 'activity', kind: 'thinking', label: thinking })
    w.onNodeDelta(node, { type: 'activity', kind: 'tool', label: 'Bash', detail: toolArgs })
    w.onNodeDelta(node, { type: 'activity', kind: 'tool_result', label: 'Bash', detail: toolOutput })
    triggerEventsFlush(w, 5500)

    const payload = deltaPayloads().at(-1)!
    const events = payload.events as Array<{ kind: string; label: string; detail?: string }>
    expect(events).toHaveLength(3)
    // thinking 全文在 label（旧实现落库前截 100 字 —— 裁决后必须全文）
    expect(events[0]).toMatchObject({ kind: 'thinking' })
    expect(events[0]!.label).toHaveLength(500)
    // tool：label=工具名、detail=参数 JSON 全文（旧实现截 60 字）
    expect(events[1]).toMatchObject({ kind: 'tool', label: 'Bash' })
    expect(events[1]!.detail).toHaveLength(toolArgs.length)
    // tool_result：输出全文（旧实现整体丢弃）
    expect(events[2]).toMatchObject({ kind: 'tool_result', label: 'Bash' })
    expect(events[2]!.detail).toHaveLength(8000)
  })

  it('status/log 进 events 但不进 activity 环（面板策展缓存排除噪音）', () => {
    const w = makeWriter()
    w.onNodeStart(node)
    w.onNodeDelta(node, { type: 'activity', kind: 'status', label: 'started' })
    w.onNodeDelta(node, { type: 'activity', kind: 'log', label: 'noise' })
    w.onNodeDelta(node, { type: 'activity', kind: 'tool', label: 'Read', detail: '{"path":"a.ts"}' })
    triggerEventsFlush(w, 5500)

    const payload = deltaPayloads().at(-1)!
    expect((payload.events as Array<{ kind: string }>).map((e) => e.kind)).toEqual([
      'status',
      'log',
      'tool',
    ])
    expect((payload.activity as Array<{ kind: string }>).map((a) => a.kind)).toEqual(['tool'])
  })

  it('activity 环的 summary 是展示派生（≤80 字），label 保留全文', () => {
    const w = makeWriter()
    w.onNodeStart(node)
    const long = 'a'.repeat(300)
    w.onNodeDelta(node, { type: 'activity', kind: 'tool_result', label: 'Read', detail: long })
    triggerEventsFlush(w, 5500)

    const payload = deltaPayloads().at(-1)!
    const activity = (payload.activity as Array<{ label: string; summary: string }>)[0]!
    expect(activity.summary).toHaveLength(81) // 80 + '…'
    // 保真不受策展缓存影响
    expect((payload.events as Array<{ detail?: string }>)[0]!.detail).toHaveLength(300)
  })

  it('events 落库双节拍：text 1s，events 5s 才随刷', () => {
    const w = makeWriter()
    w.onNodeStart(node)
    w.onNodeDelta(node, { type: 'text', text: 'hello' })
    w.onNodeDelta(node, { type: 'activity', kind: 'tool', label: 'Bash', detail: '{}' })
    expect(deltaPayloads().at(-1)).toHaveProperty('events') // 首刷即带（last=0 视为过期）

    vi.setSystemTime(new Date('2026-09-06T10:00:01Z').getTime() + 500) // +1.5s
    w.onNodeDelta(node, { type: 'text', text: ' world' })
    const mid = deltaPayloads().at(-1)!
    expect(mid.text).toBe('hello world')
    expect(mid).not.toHaveProperty('events') // 1s 节拍刷 text，events 未到期

    vi.setSystemTime(new Date('2026-09-06T10:00:06Z')) // +6s
    w.onNodeDelta(node, { type: 'activity', kind: 'error', label: 'boom' })
    const slow = deltaPayloads().at(-1)!
    expect(slow).toHaveProperty('events')
  })

  it('onNodeEnd 终态合并 activity + events（回放数据源）', async () => {
    const w = makeWriter()
    w.onNodeStart(node)
    w.onNodeDelta(node, { type: 'activity', kind: 'tool', label: 'Bash', detail: '{"command":"ls"}' })
    w.onNodeEnd({
      nodeId: 'n1',
      nodeName: '规划',
      startedAt: '2026-09-06T10:00:00Z',
      endedAt: '2026-09-06T10:00:02Z',
      status: 'success',
      input: {},
      output: { text: '最终正文' },
    } satisfies IExecutedNode)
    await flushWrites()

    const out = finalOutput()!
    expect(out.text).toBe('最终正文')
    expect(out.activity).toHaveLength(1)
    expect((out.events as Array<{ kind: string }>)[0]).toMatchObject({ kind: 'tool', label: 'Bash' })
  })

  it('保险丝：单条 detail 超 64KB 截断并标注，条数超 800 丢最旧', async () => {
    const w = makeWriter()
    w.onNodeStart(node)
    w.onNodeDelta(node, {
      type: 'activity',
      kind: 'tool_result',
      label: 'Read',
      detail: 'x'.repeat(70 * 1024),
    })
    const payload = deltaPayloads().at(-1)!
    const events = payload.events as Array<{ detail?: string }>
    expect(events[0]!.detail).toContain('…[fuse-truncated]')
    expect(events[0]!.detail!.length).toBeLessThan(70 * 1024)

    for (let i = 0; i < 805; i++) {
      w.onNodeDelta(node, { type: 'activity', kind: 'status', label: `s${i}` })
    }
    w.onNodeEnd({
      nodeId: 'n1',
      nodeName: '规划',
      startedAt: '2026-09-06T10:00:00Z',
      endedAt: '2026-09-06T10:00:02Z',
      status: 'success',
      input: {},
      output: {},
    } satisfies IExecutedNode)
    await flushWrites()
    const out = finalOutput()!
    const finalEvents = out.events as Array<{ label: string }>
    expect(finalEvents).toHaveLength(800)
    // 丢最旧保最近：最后一条是最新的 status，最早的 s0 已被挤出
    expect(finalEvents.at(-1)!.label).toBe('s804')
    expect(finalEvents[0]!.label).not.toBe('s0')
  })
})

describe('span-writer user_input 快节拍（2026-09-08 可操作终端）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunQuery.mockResolvedValue({ records: [], affected: 1 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('插话即时落库：不等 1s/5s 节拍，events 与 activity 环双通道都有', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T10:00:00Z').getTime())
    const w = makeWriter()
    w.onNodeStart(node)
    await flushWrites()
    mockRunQuery.mockClear()

    w.onNodeDelta(node, { type: 'activity', kind: 'user_input', label: '重点看登录模块' })
    await flushWrites()

    // 即时：无节拍门控，一条 delta 一次落库
    const payloads = deltaPayloads()
    expect(payloads).toHaveLength(1)
    const events = payloads[0]!['events'] as Array<{ kind: string; label: string }>
    expect(events.some((e) => e.kind === 'user_input' && e.label === '重点看登录模块')).toBe(true)
    const activity = payloads[0]!['activity'] as Array<{ kind: string }>
    expect(activity.some((a) => a.kind === 'user_input')).toBe(true)
  })

  it('终态合并保留 user_input（回放审计：谁在何时对哪个节点说了什么）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T10:00:00Z').getTime())
    const w = makeWriter()
    w.onNodeStart(node)
    await flushWrites()
    w.onNodeDelta(node, { type: 'activity', kind: 'user_input', label: '补一条约束' })
    await flushWrites()
    w.onNodeEnd({
      nodeId: 'n1',
      nodeName: '规划',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'success',
      input: {},
      output: { text: '完成' },
    } as IExecutedNode)
    await flushWrites()
    const output = finalOutput()
    const events = (output?.['events'] ?? []) as Array<{ kind: string; label: string }>
    expect(events.some((e) => e.kind === 'user_input' && e.label === '补一条约束')).toBe(true)
    expect(output?.['text']).toBe('完成')
  })
})
