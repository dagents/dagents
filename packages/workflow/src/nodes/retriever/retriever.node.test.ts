import { describe, it, expect, vi } from 'vitest'
import { RetrieverNode } from './retriever.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeContext(retriever?: IExecutionContext['historyRetriever']): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false, historyRetriever: retriever }
}

const fakeDocs = [
  { role: 'user', content: 'what is the weather?', createdAt: '2026-01-01T00:00:00Z' },
  { role: 'assistant', content: 'it is sunny', createdAt: '2026-01-01T00:00:01Z' },
]

describe('RetrieverNode', () => {
  it('retrieves docs via the injected historyRetriever', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'retrieverAgentflow',
      inputs: { query: 'weather', topK: 2 },
    }
    const retriever = vi.fn().mockResolvedValue(fakeDocs)
    const result = await node.run(nodeData, 'weather query', makeContext(retriever))
    expect(retriever).toHaveBeenCalledWith('weather', 2)
    expect(result.output.docs).toEqual(fakeDocs)
    expect(result.output.content).toBe('[user] what is the weather?\n[assistant] it is sunny')
  })

  it('uses input string when no query configured', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = { id: 'n1', name: 'retrieverAgentflow', inputs: {} }
    const retriever = vi.fn().mockResolvedValue([])
    const result = await node.run(nodeData, 'fallback query', makeContext(retriever))
    expect(result.output.query).toBe('fallback query')
  })

  it('throws a clear error when no retrieval source is wired', async () => {
    const node = new RetrieverNode()
    const nodeData: INodeData = { id: 'n1', name: 'retrieverAgentflow', inputs: { query: 'x' } }
    await expect(node.run(nodeData, '', makeContext())).rejects.toThrow(/historyRetriever/)
  })

  it('has correct static metadata', () => {
    const node = new RetrieverNode()
    expect(node.name).toBe('retrieverAgentflow')
    expect(node.type).toBe('Retriever')
  })
})
