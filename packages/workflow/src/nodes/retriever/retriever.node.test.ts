import { describe, it, expect } from 'vitest'
import { RetrieverNode } from './retriever.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('RetrieverNode (stub)', () => {
  it('returns a placeholder output with the query', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'retrieverAgentflow',
      inputs: { query: 'what is the weather?' },
    }
    const result = await node.run(nodeData, 'weather query', makeContext())
    expect(result.output.query).toBe('what is the weather?')
    expect(result.output.stub).toBe(true)
  })

  it('uses input string when no query configured', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = { id: 'n1', name: 'retrieverAgentflow', inputs: {} }
    const result = await node.run(nodeData, 'fallback query', makeContext())
    expect(result.output.query).toBe('fallback query')
  })

  it('has correct static metadata', () => {
    const node = new RetrieverNode()
    expect(node.name).toBe('retrieverAgentflow')
    expect(node.type).toBe('Retriever')
  })
})
