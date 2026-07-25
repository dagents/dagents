import { describe, it, expect } from 'vitest'
import { ToolNode } from './tool.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('ToolNode (stub)', () => {
  it('returns a placeholder output with the tool name', async () => {
    const node = new ToolNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'toolAgentflow',
      inputs: { toolName: 'web-search' },
    }
    const result = await node.run(nodeData, 'search query', makeContext())
    expect(result.output.toolName).toBe('web-search')
    expect(result.output.stub).toBe(true)
  })

  it('throws when no tool name configured', async () => {
    const node = new ToolNode()
    const nodeData: INodeData = { id: 'n1', name: 'toolAgentflow', inputs: {} }
    await expect(node.run(nodeData, 'input', makeContext())).rejects.toThrow(/tool.*name/i)
  })

  it('has correct static metadata', () => {
    const node = new ToolNode()
    expect(node.name).toBe('toolAgentflow')
    expect(node.type).toBe('Tool')
  })
})
