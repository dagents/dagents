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
