import { describe, it, expect } from 'vitest'
import { normalizeRunNodeSpan, type RunNodeSpan } from './node-spans'

/**
 * 边界归一函数的形状契约（2026-09-17 单源收敛后重写：旧测试钉的是
 * scheduler → console 的死映射，0 引用）。normalizeRunNodeSpan 是三个
 * 消费方（canvas 结果面板 / 聊天执行卡 / 终端格式化层）共用的唯一
 * 边界：nodeId/node_id 双写在此一次归一，输出规范 camelCase。
 */

const baseRow: Record<string, unknown> = {
  nodeId: 'n1',
  nodeLabel: 'Start',
  nodeType: 'customNode',
  ordinal: 0,
  status: 'done',
  startedAt: '2026-09-17T01:00:00.000Z',
  finishedAt: '2026-09-17T01:00:02.000Z',
  durationMs: 2000,
  tokens: { claude: { inputTokens: 10, outputTokens: 5 } },
  cost: 0.42,
  error: null,
  traceId: 'trace-abc',
  input: { model: 'sonnet' },
  output: { text: 'hi' },
}

describe('normalizeRunNodeSpan', () => {
  it('规范 camelCase 行原样通过（网关真实形状）', () => {
    const span = normalizeRunNodeSpan(baseRow)
    expect(span).toEqual({
      nodeId: 'n1',
      nodeLabel: 'Start',
      nodeType: 'customNode',
      ordinal: 0,
      status: 'done',
      error: null,
      startedAt: '2026-09-17T01:00:00.000Z',
      finishedAt: '2026-09-17T01:00:02.000Z',
      durationMs: 2000,
      tokens: { claude: { inputTokens: 10, outputTokens: 5 } },
      cost: 0.42,
      traceId: 'trace-abc',
      input: { model: 'sonnet' },
      output: { text: 'hi' },
    } satisfies RunNodeSpan)
  })

  it('snake_case node_id 兜底 → 归一为 camelCase nodeId', () => {
    const { nodeId, ...rest } = baseRow
    void nodeId
    const span = normalizeRunNodeSpan({ ...rest, node_id: 'legacy-1' })
    expect(span.nodeId).toBe('legacy-1')
    // camelCase 优先于 snake_case
    expect(normalizeRunNodeSpan({ ...rest, node_id: 'legacy-1', nodeId: 'camel-1' }).nodeId).toBe('camel-1')
  })

  it('字段缺席/类型不符全部静默归 null（不抛错）', () => {
    const span = normalizeRunNodeSpan({ nodeId: 'n2', status: 'running' })
    expect(span.nodeLabel).toBeNull()
    expect(span.nodeType).toBeNull()
    expect(span.status).toBe('running')
    expect(span.durationMs).toBeNull()
    expect(span.cost).toBeNull()
    expect(span.input).toBeNull()
    expect(span.output).toBeNull()
    expect(span.tokens).toBeNull()
  })

  it('input/output 容忍字符串形态（字符串化 JSON 桩）', () => {
    const span = normalizeRunNodeSpan({ ...baseRow, input: '{"model":"x"}', output: 'plain text' })
    expect(span.input).toBe('{"model":"x"}')
    expect(span.output).toBe('plain text')
  })

  it('非对象输入（null/数组/原始值）退化为空壳而非崩溃', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      const span = normalizeRunNodeSpan(raw)
      expect(span.nodeId).toBe('')
      expect(span.status).toBeNull()
    }
  })
})

/* ── R6 渐进产物（2026-10-08）：fetchRunNodeSpans 的 deliverables 透传契约 ──
 * 决策 F（design-artifacts.md §④-2）：null = 字段缺席（旧网关 / 投影读失败）
 * → 聚合区整体不渲染；[] = 新网关零产出（诚实空态）——两种语义必须区分，
 * 本组钉住 fetch 层不混淆两者。 */

import { fetchRunNodeSpans } from './node-spans'
import type { DeliverableItem } from '@dagents/contracts'
// 原文件顶部 import 只有 describe/it/expect——本追加块补 afterEach
//（ESM import 提升，追加位置合法）
import { afterEach } from 'vitest'

describe('fetchRunNodeSpans · deliverables 透传（R6 决策 F）', () => {
  const originalFetch = globalThis.fetch

  function stubFetch(payload: unknown, status = 200): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const sample: DeliverableItem = {
    nodeId: 'a',
    nodeLabel: '翻译',
    nodeType: 'llmAgentflow',
    ordinal: 0,
    status: 'done',
    tokens: { inputTokens: 1, outputTokens: 2 },
    output: { text: 'hi' },
    inheritedFromRunId: null,
    subflowName: null,
  }

  it('字段在场 → 数组原样透传', async () => {
    stubFetch({ success: true, data: { runId: 'r1', spans: [], deliverables: [sample] } })
    const r = await fetchRunNodeSpans('r1')
    expect(r.deliverables).toEqual([sample])
  })

  it('字段缺席（旧网关）→ null（≠ 空数组：聚合区整体不渲染）', async () => {
    stubFetch({ success: true, data: { runId: 'r1', spans: [] } })
    const r = await fetchRunNodeSpans('r1')
    expect(r.deliverables).toBeNull()
  })

  it('字段为空数组（新网关零产出）→ []（诚实空态，非降级）', async () => {
    stubFetch({ success: true, data: { runId: 'r1', spans: [], deliverables: [] } })
    const r = await fetchRunNodeSpans('r1')
    expect(r.deliverables).toEqual([])
  })

  it('字段形状坏损（非数组）→ 防御归 null', async () => {
    stubFetch({ success: true, data: { runId: 'r1', spans: [], deliverables: { oops: true } } })
    const r = await fetchRunNodeSpans('r1')
    expect(r.deliverables).toBeNull()
  })

  it('非 2xx / 网络异常 → deliverables 随整个结果归 null（不造数据）', async () => {
    stubFetch({ success: false }, 502)
    expect((await fetchRunNodeSpans('r1')).deliverables).toBeNull()
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof globalThis.fetch
    expect((await fetchRunNodeSpans('r1')).deliverables).toBeNull()
  })
})
