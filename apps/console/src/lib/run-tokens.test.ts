/**
 * run-tokens 单测（PRD R2.3 双口径，AC-R2-3 第一分句「总 token = 前驱
 * 累计 + 本次新增」的计算面）：
 *  - splitTokensBySource：cached span 的 tokens 进继承桶（seedTokens 传承），
 *    其余（done/failed/running）进新增桶（= usage_events 记账面）；
 *  - dualBasisTokens：lineageTokens（谱系前驱累计）null = 根运行不双口径；
 *    继承 = 前驱累计 + 本 run cached 继承值；total = inherited + fresh。
 */
import { describe, it, expect } from 'vitest'
import { splitTokensBySource, dualBasisTokens } from './run-tokens'
import type { RunNodeSpan } from '@/lib/node-spans'

function span(status: string, tokens: unknown): RunNodeSpan {
  return {
    nodeId: `n-${status}-${Math.random().toString(36).slice(2, 7)}`,
    nodeLabel: 'N',
    nodeType: 'llmAgentflow',
    ordinal: 0,
    status,
    error: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    tokens,
    cost: null,
    traceId: null,
    input: null,
    output: null,
  }
}

describe('splitTokensBySource（分桶：cached 继承 / 其余新增）', () => {
  it('cached 进继承桶、done/failed/running 进新增桶；双命名（inputTokens/prompt_tokens）都认', () => {
    const { fresh, cached } = splitTokensBySource([
      span('cached', { inputTokens: 120, outputTokens: 80, total_tokens: 200 }),
      span('done', { prompt_tokens: 30, completion_tokens: 20 }),
      span('failed', null),
      span('running', { inputTokens: 1, outputTokens: 1 }),
    ])
    expect(cached).toBe(200)
    expect(fresh).toBe(52)
  })

  it('无 tokens / 空数组 → 双零；cached 无 tokens 不计（老种子兼容面）', () => {
    expect(splitTokensBySource([])).toEqual({ fresh: 0, cached: 0 })
    expect(splitTokensBySource([span('cached', null), span('done', {})])).toEqual({
      fresh: 0,
      cached: 0,
    })
  })
})

describe('dualBasisTokens（AC-R2-3 第一分句：总 = 前驱累计 + 本次新增）', () => {
  const spans = [
    span('cached', { inputTokens: 120, outputTokens: 80 }),
    span('done', { inputTokens: 30, outputTokens: 20 }),
  ]

  it('继承 = 谱系前驱累计 + 本 run cached 继承值；新增 = 真实执行；total 合计', () => {
    const dual = dualBasisTokens(spans, 500)!
    expect(dual.inherited).toBe(500 + 200)
    expect(dual.fresh).toBe(50)
    expect(dual.total).toBe(750)
  })

  it('lineageTokens null（根运行/旧网关）→ null（无双口径，面板不渲染）', () => {
    expect(dualBasisTokens(spans, null)).toBeNull()
  })

  it('两侧皆零 → null（零数据不渲染空行）', () => {
    expect(dualBasisTokens([span('done', null)], 0)).toBeNull()
  })
})
