/**
 * applyAutoLayout tests —— 生成流确定性布局的形状保证。
 *
 * 核心不变量（对应画布节点物理尺寸 280×80、步长 360×150）：
 * 任意两个节点的坐标，要么横向错开 ≥ xStep，要么纵向错开 ≥ yStep ——
 * 即物理上不可能重叠。这是「LLM 坐标不可信、按拓扑重排」的验收线。
 */
import { describe, it, expect } from 'vitest'
import { applyAutoLayout, DEFAULT_AUTO_LAYOUT_STEPS } from './auto-layout.js'
import type { FlowData } from '../types/flow.js'

function flowOf(
  nodes: string[],
  edges: [string, string][],
  position: { x: number; y: number } = { x: 0, y: 0 },
): FlowData {
  return {
    nodes: nodes.map((id) => ({
      id,
      type: 'customNode',
      position: { ...position },
      data: { name: 'llmAgentflow' },
    })),
    edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
  }
}

function posMap(flow: FlowData): Map<string, { x: number; y: number }> {
  return new Map(flow.nodes.map((n) => [n.id, n.position!]))
}

/** 任意节点对满足「横向 ≥ xStep 或纵向 ≥ yStep」——物理不可重叠。 */
function expectNoOverlap(flow: FlowData, steps = DEFAULT_AUTO_LAYOUT_STEPS) {
  const positions = flow.nodes.map((n) => n.position!)
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = Math.abs(positions[i]!.x - positions[j]!.x)
      const dy = Math.abs(positions[i]!.y - positions[j]!.y)
      expect(
        dx >= steps.xStep || dy >= steps.yStep,
        `nodes ${flow.nodes[i]!.id} & ${flow.nodes[j]!.id} overlap: dx=${dx} dy=${dy}`,
      ).toBe(true)
    }
  }
}

describe('applyAutoLayout', () => {
  it('linear chain stays on one horizontal line, strictly left-to-right', () => {
    const out = applyAutoLayout(
      flowOf(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
        ],
      ),
    )
    const p = posMap(out)
    expect(p.get('a')).toEqual({ x: 0, y: 0 })
    expect(p.get('b')).toEqual({ x: 360, y: 0 })
    expect(p.get('c')).toEqual({ x: 720, y: 0 })
    expect(p.get('d')).toEqual({ x: 1080, y: 0 })
  })

  it('diamond opens up symmetrically and rejoins centered', () => {
    const out = applyAutoLayout(
      flowOf(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['a', 'c'],
          ['b', 'd'],
          ['c', 'd'],
        ],
      ),
    )
    const p = posMap(out)
    // 同层 b/c 纵向对称张开
    expect(p.get('b')!.y).toBe(-75)
    expect(p.get('c')!.y).toBe(75)
    expect(p.get('b')!.x).toBe(p.get('c')!.x)
    // 汇合点回到分支中轴
    expect(p.get('d')).toEqual({ x: 720, y: 0 })
  })

  it('every edge points strictly left-to-right (layering is a valid topological rank)', () => {
    const f = flowOf(
      ['s', 'cond', 't1', 't2', 't3', 'join', 'end'],
      [
        ['s', 'cond'],
        ['cond', 't1'],
        ['cond', 't2'],
        ['t2', 't3'],
        ['t1', 'join'],
        ['t3', 'join'],
        ['join', 'end'],
      ],
    )
    const p = posMap(applyAutoLayout(f))
    for (const e of f.edges) {
      expect(p.get(e.target)!.x).toBeGreaterThan(p.get(e.source)!.x)
    }
  })

  it('satisfies the no-overlap invariant on a branchy flow with garbage stacked input', () => {
    // LLM 典型坏输出：全部节点挤在 (0,0)
    const f = flowOf(
      ['s', 'a', 'b', 'c', 'd', 'e2', 'f2', 'g'],
      [
        ['s', 'a'],
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'e2'],
        ['d', 'f2'],
        ['e2', 'f2'],
        ['f2', 'g'],
      ],
    )
    expectNoOverlap(applyAutoLayout(f))
  })

  it('isolated nodes share layer 0 and spread vertically', () => {
    const out = applyAutoLayout(flowOf(['x', 'y', 'z'], []))
    const p = posMap(out)
    expect(p.get('x')!.y).toBe(-150)
    expect(p.get('y')!.y).toBe(0)
    expect(p.get('z')!.y).toBe(150)
    expect([...p.values()].every((v) => v.x === 0)).toBe(true)
  })

  it('cyclic input does not hang and still lays out without overlap', () => {
    const f = flowOf(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    )
    const out = applyAutoLayout(f)
    expectNoOverlap(out)
    expect(out.nodes).toHaveLength(3)
  })

  it('dedupes parallel edges, ignores self-loops and dangling refs', () => {
    const f = flowOf(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['a', 'b'],
        ['a', 'a'],
        ['a', 'ghost'],
        ['ghost', 'b'],
      ],
    )
    const p = posMap(applyAutoLayout(f))
    expect(p.get('b')!.x).toBe(360) // 重复边只算一次，b 仍在第 1 层
  })

  it('is deterministic and does not mutate the input', () => {
    const f = flowOf(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      { x: 999, y: 999 },
    )
    const before = JSON.stringify(f)
    const first = applyAutoLayout(f)
    const second = applyAutoLayout(f)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.stringify(f)).toBe(before) // 输入原样（LLM 坐标仍在入参里）
    expect(first.nodes.map((n) => n.position)).not.toContainEqual({ x: 999, y: 999 })
  })

  it('empty flow passes through untouched', () => {
    const empty: FlowData = { nodes: [], edges: [] }
    expect(applyAutoLayout(empty)).toBe(empty)
  })

  it('respects custom steps', () => {
    const out = applyAutoLayout(flowOf(['a', 'b'], [['a', 'b']]), { xStep: 100, yStep: 50 })
    expect(posMap(out).get('b')).toEqual({ x: 100, y: 0 })
  })
})
