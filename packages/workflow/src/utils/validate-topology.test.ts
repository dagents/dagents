import { describe, it, expect } from 'vitest'
import { validateFlowTopology } from './validate-topology.js'
import { allNodes } from '../nodes/index.js'

/** AI-generated shape: registry name in `type`, config flat in `data`. */
function genNode(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, position: { x: 0, y: 0 }, data }
}

/** Canvas-saved shape: registry name in `data.name`, `type` is a React Flow
 * render type the engine never reads. */
function canvasNode(id: string, name: string, data: Record<string, unknown> = {}) {
  return { id, type: 'agentflowNode', position: { x: 0, y: 0 }, data: { name, ...data } }
}

describe('validateFlowTopology', () => {
  it('accepts a valid small DAG (generator shape) with no warnings', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow', { variables: {} }),
        genNode('llm', 'llmAgentflow', { model: 'gpt-4', prompt: 'hi' }),
        genNode('reply', 'directReplyAgentflow', { text: 'done' }),
      ],
      edges: [
        { source: 'start', target: 'llm' },
        { source: 'llm', target: 'reply' },
      ],
    })
    expect(result).toEqual({
      ok: true,
      data: {
        nodes: [
          genNode('start', 'startAgentflow', { variables: {} }),
          genNode('llm', 'llmAgentflow', { model: 'gpt-4', prompt: 'hi' }),
          genNode('reply', 'directReplyAgentflow', { text: 'done' }),
        ],
        edges: [
          { id: 'start-llm', source: 'start', target: 'llm' },
          { id: 'llm-reply', source: 'llm', target: 'reply' },
        ],
      },
      warnings: [],
    })
  })

  it('accepts the canvas shape where the registry name lives in data.name', () => {
    const result = validateFlowTopology({
      nodes: [
        canvasNode('start', 'startAgentflow'),
        canvasNode('agent', 'platformAgentAgentflow', { agentId: 'uuid-1' }),
      ],
      edges: [{ id: 'e1', source: 'start', target: 'agent' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toEqual([])
  })

  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'nodes', [], true]) {
      const result = validateFlowTopology(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('errors when nodes is empty', () => {
    const result = validateFlowTopology({ nodes: [], edges: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/no nodes/)
  })

  it('errors when no startAgentflow node exists', () => {
    const result = validateFlowTopology({
      nodes: [genNode('llm', 'llmAgentflow'), genNode('reply', 'directReplyAgentflow')],
      edges: [{ source: 'llm', target: 'reply' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.message).toMatch(/startAgentflow/)
    }
  })

  it('errors when multiple startAgentflow nodes exist', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('s1', 'startAgentflow'),
        genNode('s2', 'startAgentflow'),
        genNode('llm', 'llmAgentflow'),
      ],
      edges: [
        { source: 's1', target: 'llm' },
        { source: 's2', target: 'llm' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/s1.*s2/)
  })

  it('errors on edges referencing missing node ids', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('llm', 'llmAgentflow')],
      edges: [{ id: 'e1', source: 'start', target: 'ghost' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.edge).toBe('e1')
      expect(result.errors[0]?.message).toMatch(/ghost/)
    }
  })

  it('errors on unknown node types', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('x', 'bananaAgentflow')],
      edges: [{ source: 'start', target: 'x' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.node).toBe('x')
      expect(result.errors[0]?.message).toMatch(/bananaAgentflow/)
    }
  })

  it('errors on nodes with no type at all', () => {
    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), { id: 'x', data: {} }],
      edges: [{ source: 'start', target: 'x' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.node).toBe('x')
  })

  it('accepts every registered node type', () => {
    // Guards the whitelist derivation: every name in the registry assembly
    // must validate, so adding a node type never breaks existing flows.
    const nodes = allNodes().map((node, i) => genNode(`n${i}`, node.name))
    const edges = nodes.slice(1).map((n, i) => ({ source: `n${i}`, target: n.id }))
    const result = validateFlowTopology({ nodes, edges })
    expect(result.ok).toBe(true)
  })

  it('warns on orphan nodes but keeps the flow runnable', () => {
    const result = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('llm', 'llmAgentflow'),
        genNode('orphan', 'httpAgentflow', { url: 'https://example.com' }),
      ],
      edges: [{ source: 'start', target: 'llm' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toEqual([
        { node: 'orphan', message: expect.stringMatching(/orphan/) },
      ])
    }
  })

  it('does not warn for a lone node or an unconnected start node', () => {
    expect(validateFlowTopology({ nodes: [genNode('only', 'startAgentflow')] })).toEqual({
      ok: true,
      data: { nodes: [genNode('only', 'startAgentflow')], edges: [] },
      warnings: [],
    })

    const result = validateFlowTopology({
      nodes: [genNode('start', 'startAgentflow'), genNode('llm', 'llmAgentflow')],
      edges: [],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Missing edges default to [] — everything except the start node is orphaned.
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]?.node).toBe('llm')
    }
  })

  it('warns when a platform agent node lacks agentId (flat or nested)', () => {
    const missing = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow', { systemPrompt: 'work' }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(missing.ok).toBe(true)
    if (missing.ok) {
      expect(missing.warnings[0]?.node).toBe('pa')
      expect(missing.warnings[0]?.message).toMatch(/agentId/)
    }

    const blank = validateFlowTopology({
      nodes: [canvasNode('start', 'startAgentflow'), canvasNode('pa', 'platformAgentAgentflow', { agentId: '  ' })],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(blank.ok).toBe(true)
    if (blank.ok) expect(blank.warnings[0]?.node).toBe('pa')

    const nested = validateFlowTopology({
      nodes: [canvasNode('start', 'startAgentflow'), canvasNode('pa', 'platformAgentAgentflow', { inputs: { agentId: '' } })],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(nested.ok).toBe(true)
    if (nested.ok) expect(nested.warnings[0]?.node).toBe('pa')
  })

  it('does not warn when agentId is set (flat or nested)', () => {
    const flat = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow', { agentId: 'uuid-1' }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(flat.ok).toBe(true)
    if (flat.ok) expect(flat.warnings).toEqual([])

    const nested = validateFlowTopology({
      nodes: [
        genNode('start', 'startAgentflow'),
        genNode('pa', 'platformAgentAgentflow', { inputs: { agentId: 'uuid-2' } }),
      ],
      edges: [{ source: 'start', target: 'pa' }],
    })
    expect(nested.ok).toBe(true)
    if (nested.ok) expect(nested.warnings).toEqual([])
  })

  it('maps shape failures to errors, attaching the offending node id', () => {
    const result = validateFlowTopology({
      nodes: [{ id: 'n1', type: 'startAgentflow', data: 'not an object' }],
      edges: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.node).toBe('n1')
      expect(result.errors[0]?.message).toMatch(/invalid flow data/)
    }
  })
})
