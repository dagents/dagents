import { describe, it, expect } from 'vitest'
import { extractHumanInputPrompts, buildHumanInputsState } from '../flow-human-inputs'

describe('extractHumanInputPrompts（HumanInput 预供答案提取）', () => {
  it('平铺形态：提取 prompt/inputType/options', () => {
    const specs = extractHumanInputPrompts({
      nodes: [
        { id: 'h1', data: { name: 'humanInputAgentflow', prompt: '选个方案', inputType: 'select', options: 'A\nB' } },
      ],
    })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({
      nodeId: 'h1',
      prompt: '选个方案',
      inputType: 'select',
      options: ['A', 'B'],
      hasTemplate: false,
    })
  })

  it('嵌套 data.inputs 形态覆盖平铺（与引擎同款归一）', () => {
    const specs = extractHumanInputPrompts({
      nodes: [
        { id: 'h2', data: { name: 'humanInputAgentflow', prompt: 'x', inputs: { prompt: '嵌套的提示' } } },
      ],
    })
    expect(specs[0]?.prompt).toBe('嵌套的提示')
  })

  it('options 容错：JSON 数组串 / 逗号 / 数组形态', () => {
    const mk = (options: unknown) => extractHumanInputPrompts({
      nodes: [{ id: 'x', data: { name: 'humanInputAgentflow', prompt: 'p', options } }],
    })[0]?.options
    expect(mk('["a","b"]')).toEqual(['a', 'b'])
    expect(mk('a, b')).toEqual(['a', 'b'])
    expect(mk(['x', 'y'])).toEqual(['x', 'y'])
    expect(mk('')).toBeUndefined()
  })

  it('含模板变量的 prompt 标记 hasTemplate（预供键可能对不上运行期键）', () => {
    const specs = extractHumanInputPrompts({
      nodes: [{ id: 'h3', data: { name: 'humanInputAgentflow', prompt: '确认 {{input}} 吗' } }],
    })
    expect(specs[0]?.hasTemplate).toBe(true)
  })

  it('非 HumanInput 节点 / 畸形输入零结果', () => {
    expect(extractHumanInputPrompts({
      nodes: [
        { id: 'a', data: { name: 'llmAgentflow', prompt: 'x' } },
        { id: 'b', data: {} },
        'not-a-node',
      ],
    })).toEqual([])
    expect(extractHumanInputPrompts(null)).toEqual([])
    expect(extractHumanInputPrompts({ edges: [] })).toEqual([])
  })
})

describe('buildHumanInputsState（答案表 → run body state）', () => {
  const specs = extractHumanInputPrompts({
    nodes: [
      { id: 'h1', data: { name: 'humanInputAgentflow', prompt: '选个方案' } },
      { id: 'h2', data: { name: 'humanInputAgentflow', prompt: '补充说明' } },
    ],
  })

  it('按 prompt 键控、跳过空答案', () => {
    const state = buildHumanInputsState(specs, { h1: ' A ', h2: '   ' })
    expect(state).toEqual({ '选个方案': 'A' })
  })

  it('全空 → undefined（不污染 run body）', () => {
    expect(buildHumanInputsState(specs, {})).toBeUndefined()
    expect(buildHumanInputsState([], { x: 'y' })).toBeUndefined()
  })
})
