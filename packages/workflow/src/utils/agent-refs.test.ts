import { describe, it, expect } from 'vitest'
import { findAgentReferences } from './agent-refs.js'

describe('findAgentReferences', () => {
  const agentId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

  it('returns empty for non-object / missing nodes', () => {
    expect(findAgentReferences(null, agentId)).toEqual([])
    expect(findAgentReferences(undefined, agentId)).toEqual([])
    expect(findAgentReferences({}, agentId)).toEqual([])
    expect(findAgentReferences({ nodes: 'bad' }, agentId)).toEqual([])
  })

  it('finds reference from data.inputs.agentId', () => {
    const flow = {
      nodes: [
        {
          id: 'node-1',
          type: 'platformAgentAgentflow',
          data: { inputs: { agentId } },
        },
      ],
    }
    expect(findAgentReferences(flow, agentId)).toEqual(['node-1'])
  })

  it('finds reference from flattened data.agentId', () => {
    const flow = {
      nodes: [
        {
          id: 'node-2',
          name: 'platformAgentAgentflow',
          data: { agentId },
        },
      ],
    }
    expect(findAgentReferences(flow, agentId)).toEqual(['node-2'])
  })

  it('ignores non-platform-agent nodes', () => {
    const flow = {
      nodes: [
        { id: 'node-3', type: 'agentAgentflow', data: { inputs: { agentId } } },
      ],
    }
    expect(findAgentReferences(flow, agentId)).toEqual([])
  })

  it('returns multiple matches', () => {
    const flow = {
      nodes: [
        { id: 'n1', type: 'platformAgentAgentflow', data: { inputs: { agentId } } },
        { id: 'n2', type: 'platformAgentAgentflow', data: { agentId } },
        { id: 'n3', type: 'platformAgentAgentflow', data: { inputs: { agentId: 'other' } } },
      ],
    }
    expect(findAgentReferences(flow, agentId)).toEqual(['n1', 'n2'])
  })
})
