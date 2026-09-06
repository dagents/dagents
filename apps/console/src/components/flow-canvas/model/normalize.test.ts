import { describe, expect, it } from 'vitest'
import { normalizeDocument, serializeDocument } from './normalize'
import { INPUT_HANDLE_ID } from './flow-document'

/**
 * Golden 语义钉：normalizeDocument → serializeDocument 的往返不得改变
 * 引擎可见语义（data.name / 配置字段值 / sourceHandle / 端点 / id），
 * 且 vendor 杂项（inputs/outputAnchors/version/hideInput/targetHandle=<nodeId>）
 * 在写出时收敛为扁平规范形。
 */

describe('normalizeDocument — 生成器/模板扁平形状', () => {
  it('直接读入 customNode + data.name + 扁平字段', () => {
    const doc = normalizeDocument({
      nodes: [
        { id: 'node_1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
        {
          id: 'node_2',
          type: 'customNode',
          position: { x: 300, y: 0 },
          data: { name: 'llmAgentflow', label: '总结', model: 'p1::m1', prompt: '你好' },
        },
        { id: 'node_3', type: 'customNode', position: { x: 600, y: 0 }, data: { name: 'directReplyAgentflow', content: '完成' } },
      ],
      edges: [
        { id: 'edge_1', source: 'node_1', target: 'node_2' },
        { id: 'edge_2', source: 'node_2', target: 'node_3' },
      ],
    })
    expect(doc.nodes.map((n) => n.id)).toEqual(['node_1', 'node_2', 'node_3'])
    expect(doc.nodes[1]!.type).toBe('flowNode')
    const llm = doc.nodes[1]!.data as Record<string, unknown>
    expect(llm.name).toBe('llmAgentflow')
    expect(llm.label).toBe('总结')
    expect(llm.model).toBe('p1::m1')
    // 缺省 sourceHandle 补首个锚点（默认 'output'）
    expect(doc.edges[0]!.sourceHandle).toBe('output')
    expect(doc.edges[0]!.targetHandle).toBe(INPUT_HANDLE_ID)
  })

  it('start 节点的 inputHint/inputExample 透传（模板链路 UI 提示）', () => {
    const doc = normalizeDocument({
      nodes: [
        {
          id: 's',
          type: 'customNode',
          position: { x: 0, y: 0 },
          data: { name: 'startAgentflow', inputHint: '给我一个主题', inputExample: 'AI 编排' },
        },
      ],
      edges: [],
    })
    const start = doc.nodes[0]!.data as Record<string, unknown>
    expect(start.inputHint).toBe('给我一个主题')
    expect(start.inputExample).toBe('AI 编排')
  })
})

describe('normalizeDocument — vendor 画布保存形状', () => {
  const vendorFlow = {
    nodes: [
      {
        id: 'start_0',
        type: 'agentflowNode',
        position: { x: 100, y: 200 },
        data: {
          name: 'startAgentflow',
          label: 'Start',
          id: 'startAgentflow',
          inputs: { variables: { theme: 'AI' } },
          outputAnchors: [{ id: 'output', label: 'Output', name: 'Output' }],
          version: 1,
          hideInput: false,
        },
      },
      {
        id: 'cond_0',
        type: 'agentflowNode',
        position: { x: 400, y: 200 },
        data: {
          name: 'conditionAgentflow',
          label: 'Condition',
          id: 'conditionAgentflow',
          inputs: { conditions: [{ comparisonOperator: '===' }] },
          outputAnchors: [
            { id: 'true', label: 'True', name: 'True' },
            { id: 'false', label: 'False', name: 'False' },
          ],
          version: 1,
        },
      },
      {
        id: 'note_0',
        type: 'stickyNote',
        position: { x: 50, y: 400 },
        width: 220,
        height: 120,
        data: { content: '便签内容' },
      },
    ],
    edges: [
      // vendor 约定：targetHandle = 目标节点 id
      { id: 'e1', source: 'start_0', sourceHandle: 'output', target: 'cond_0', targetHandle: 'cond_0', type: 'agentflowEdge', data: { sourceColor: '#10b981' } },
      { id: 'e2', source: 'cond_0', sourceHandle: 'true', target: 'start_0', targetHandle: 'start_0' },
    ],
    viewport: { x: 10, y: 20, zoom: 0.85 },
  }

  it('嵌套 inputs 覆盖扁平、杂项键剥离、targetHandle 归一', () => {
    const doc = normalizeDocument(vendorFlow)
    expect(doc.nodes).toHaveLength(3)
    const cond = doc.nodes[1]!.data as Record<string, unknown>
    expect(cond.conditions).toEqual([{ comparisonOperator: '===' }])
    expect(cond.outputAnchors).toBeUndefined()
    expect(cond.version).toBeUndefined()
    expect(doc.edges.every((e) => e.targetHandle === INPUT_HANDLE_ID)).toBe(true)
    // 便签读 vendor 的 content 键
    const note = doc.nodes[2]!.data as { text: string }
    expect(note.text).toBe('便签内容')
    expect(doc.viewport).toEqual({ x: 10, y: 20, zoom: 0.85 })
  })

  it('condition 分支边的 sourceHandle 原样保留', () => {
    const doc = normalizeDocument(vendorFlow)
    expect(doc.edges[1]!.sourceHandle).toBe('true')
  })

  it('写出为扁平规范形：legacy inputs/outputAnchors/version 收敛消失', () => {
    const out = serializeDocument(normalizeDocument(vendorFlow))
    expect(out.nodes).toHaveLength(3)
    const condOut = out.nodes[1]!.data as Record<string, unknown>
    expect(condOut.name).toBe('conditionAgentflow')
    expect(condOut.conditions).toEqual([{ comparisonOperator: '===' }])
    expect('inputs' in condOut).toBe(false)
    expect('outputAnchors' in condOut).toBe(false)
    expect('version' in condOut).toBe(false)
    expect(out.nodes[1]!.type).toBe('customNode')
    // 边：targetHandle/agentflowEdge 类型/data 全部剥离，sourceHandle 保留
    expect(out.edges[0]).toEqual({ id: 'e1', source: 'start_0', target: 'cond_0', sourceHandle: 'output' })
    expect(out.edges[1]!.sourceHandle).toBe('true')
    // 便签保尺寸
    const note = out.nodes[2] as unknown as { type: string; width?: number; data: { text: string } }
    expect(note.type).toBe('stickyNote')
    expect(note.width).toBe(220)
    expect(note.data.text).toBe('便签内容')
  })
})

describe('normalizeDocument — 边角与防御', () => {
  it('未知节点渲染占位（name 保留），未知 data 键往返透传', () => {
    const raw = {
      nodes: [
        { id: 'u1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'loopAgentflow', loopCount: 3, custom: 'x' } },
      ],
      edges: [],
    }
    const doc = normalizeDocument(raw)
    const data = doc.nodes[0]!.data as Record<string, unknown>
    expect(data.name).toBe('loopAgentflow')
    expect(data.loopCount).toBe(3)
    const out = serializeDocument(doc)
    expect((out.nodes[0]!.data as Record<string, unknown>).custom).toBe('x')
  })

  it('旧 vendor 形态：注册名在 node.type 上也能解析', () => {
    const doc = normalizeDocument({
      nodes: [
        { id: 'n1', type: 'llmAgentflow', position: { x: 0, y: 0 }, data: { prompt: 'p' } },
      ],
      edges: [],
    })
    const data = doc.nodes[0]!.data as Record<string, unknown>
    expect(data.name).toBe('llmAgentflow')
    expect(data.prompt).toBe('p')
    expect(data.label).toBe('LLM')
  })

  it('悬空边 / 重复 id / 缺 id 节点被丢弃', () => {
    const doc = normalizeDocument({
      nodes: [
        { id: 'a', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
        { type: 'customNode', position: { x: 1, y: 1 }, data: { name: 'startAgentflow' } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'ghost' },
        { id: 'e2', source: 'a', target: 'a' },
        { id: 'e2', source: 'a', target: 'a' },
      ],
    })
    expect(doc.nodes).toHaveLength(1)
    expect(doc.edges).toHaveLength(1)
  })

  it('空 / 畸形输入退化为空文档', () => {
    expect(normalizeDocument(null)).toEqual({ nodes: [], edges: [], viewport: undefined })
    expect(normalizeDocument({ nodes: 'x' })).toEqual({ nodes: [], edges: [], viewport: undefined })
  })

  it('iteration 节点读入为普通流程节点（D2 去容器化）', () => {
    const doc = normalizeDocument({
      nodes: [
        { id: 'it', type: 'iteration', position: { x: 0, y: 0 }, data: { name: 'iterationAgentflow', items: '["a"]' } },
      ],
      edges: [],
    })
    expect(doc.nodes[0]!.type).toBe('flowNode')
    expect((doc.nodes[0]!.data as Record<string, unknown>).name).toBe('iterationAgentflow')
  })
})

describe('serializeDocument — 幂等', () => {
  it('规范形再读再写不变（定点）', () => {
    const canonical = {
      nodes: [
        { id: 'a', type: 'customNode', position: { x: 10, y: 20 }, data: { name: 'startAgentflow', label: 'Start', variables: {} } },
        { id: 'b', type: 'customNode', position: { x: 310, y: 20 }, data: { name: 'directReplyAgentflow', label: 'Direct Reply', text: 'hi' } },
      ],
      edges: [{ id: 'a-b', source: 'a', target: 'b', sourceHandle: 'output' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    }
    const once = serializeDocument(normalizeDocument(canonical))
    const twice = serializeDocument(normalizeDocument(once))
    expect(twice).toEqual(once)
    expect(once.nodes[0]).toEqual(canonical.nodes[0])
    expect(once.edges[0]).toEqual(canonical.edges[0])
  })
})
