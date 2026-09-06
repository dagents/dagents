import { describe, expect, it } from 'vitest'
import { connectionAllowed, isDuplicateEdge, wouldCreateCycle } from './connection-rules'

describe('connectionAllowed', () => {
  const edges = [
    { source: 'a', target: 'b', sourceHandle: 'output' },
    { source: 'b', target: 'c', sourceHandle: 'true' },
  ]

  it('拒绝自环', () => {
    expect(connectionAllowed(edges, { source: 'a', target: 'a', sourceHandle: 'output' })).toBe(false)
  })

  it('拒绝重复边（同 source+handle+target；null 与 undefined 视为同值）', () => {
    expect(isDuplicateEdge(edges, 'a', 'b', 'output')).toBe(true)
    expect(isDuplicateEdge(edges, 'a', 'b', null)).toBe(false)
    expect(isDuplicateEdge(edges, 'a', 'b', undefined)).toBe(false)
  })

  it('拒绝会成环的连线（图环不允许，循环走 Iteration 锚点）', () => {
    expect(connectionAllowed(edges, { source: 'c', target: 'a', sourceHandle: 'output' })).toBe(false)
    // 间接环：c → b（b 可达 c）
    expect(connectionAllowed(edges, { source: 'c', target: 'b', sourceHandle: 'output' })).toBe(false)
  })

  it('允许正常前向连线', () => {
    expect(connectionAllowed(edges, { source: 'c', target: 'd', sourceHandle: 'output' })).toBe(true)
  })

  it('wouldCreateCycle：target 不可达 source 即无环', () => {
    expect(wouldCreateCycle(edges, 'a', 'd')).toBe(false)
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true)
  })
})
