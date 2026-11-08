import { describe, it, expect } from 'vitest'
import { canonicalJson, computeInputHash, NON_DETERMINISTIC_KEYS } from './input-hash.js'

/**
 * AC-R1-4：inputHash 确定性——同输入多次同 hash；对象键序打乱不变；数组序
 * 敏感；未引用 runtime 键不影响（口径本身在 executor 侧预演，这里钉序列化
 * 底座）。design-recover §⑥ 单测表第一行。
 */

describe('canonicalJson', () => {
  it('同输入多次序列化结果相同', () => {
    const value = { b: 1, a: { d: [1, 'x', null], c: true } }
    expect(canonicalJson(value)).toBe(canonicalJson(value))
  })

  it('对象键序打乱不影响结果（递归排序）', () => {
    const left = { z: 1, a: { y: [1, 2], b: 's' }, m: [{ q: 1, p: 2 }] }
    const right = { m: [{ p: 2, q: 1 }], a: { b: 's', y: [1, 2] }, z: 1 }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  it('数组序敏感（序本身是语义）', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })

  it('undefined/函数跳过：对象键丢弃、数组位占 null 保长度', () => {
    const withNoise = { a: 1, u: undefined, f: () => 'x', arr: [1, undefined, 2] }
    expect(canonicalJson(withNoise)).toBe(canonicalJson({ a: 1, arr: [1, null, 2] }))
  })

  it('Date 序列化为 ISO（同一时刻同一串）', () => {
    const t = new Date('2026-10-07T00:00:00.000Z')
    expect(canonicalJson({ at: t })).toBe(canonicalJson({ at: new Date(t.getTime()) }))
    expect(canonicalJson({ at: t })).not.toBe(canonicalJson({ at: new Date(t.getTime() + 1) }))
  })

  it('顶层 primitive 与 null 可序列化（不炸）', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(3)).toBe('3')
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('computeInputHash（AC-R1-4）', () => {
  const base = {
    nodeType: 'llmAgentflow',
    resolvedConfig: { prompt: '总结 {{a.output}}', temperature: 0.7 },
    nodeInput: { content: '上游产出', inputs: [{ content: 'A 路' }, { content: 'B 路' }] },
  }

  it('同输入多次 → 同 hash', () => {
    expect(computeInputHash(base)).toBe(computeInputHash(base))
  })

  it('对象键序打乱 → 同 hash（数组保序——序是语义）', () => {
    // 只打乱对象键的书写序（含嵌套），数组内容与序保持不变
    const shuffled = {
      nodeType: 'llmAgentflow',
      resolvedConfig: { temperature: 0.7, prompt: '总结 {{a.output}}' },
      nodeInput: {
        inputs: [{ content: 'A 路' }, { content: 'B 路' }],
        content: '上游产出',
      },
    }
    expect(computeInputHash(base)).toBe(computeInputHash(shuffled))
  })

  it('上游输出变化（nodeInput）→ hash 变（保守传递闭包的底座）', () => {
    expect(computeInputHash(base)).not.toBe(
      computeInputHash({ ...base, nodeInput: { ...base.nodeInput, content: '不同的产出' } }),
    )
  })

  it('节点配置变化（resolvedConfig）→ hash 变（AC-R1-3 口径）', () => {
    expect(computeInputHash(base)).not.toBe(
      computeInputHash({
        ...base,
        resolvedConfig: { ...base.resolvedConfig, prompt: '改过的 prompt' },
      }),
    )
  })

  it('nodeType 变化 → hash 变', () => {
    expect(computeInputHash(base)).not.toBe(
      computeInputHash({ ...base, nodeType: 'platformAgent' }),
    )
  })

  it('数组序扰动 nodeInput → hash 变', () => {
    const reordered = {
      ...base,
      nodeInput: {
        ...base.nodeInput,
        inputs: [...(base.nodeInput.inputs as unknown[])].reverse(),
      },
    }
    expect(computeInputHash(base)).not.toBe(computeInputHash(reordered))
  })

  it('NON_DETERMINISTIC_KEYS 初始为空（台账不是清单）', () => {
    expect(NON_DETERMINISTIC_KEYS.size).toBe(0)
  })
})
