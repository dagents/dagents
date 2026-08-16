import { describe, it, expect } from 'vitest'
import { ToolNode } from './tool.node.js'
import type { INodeData, IExecutionContext, IAgentTool } from '../../types/index.js'

function makeContext(toolRegistry?: Record<string, IAgentTool>): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false, toolRegistry }
}

describe('ToolNode', () => {
  it('executes the handler and returns its result', async () => {
    const node = new ToolNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'toolAgentflow',
      inputs: {
        toolName: 'format-name',
        toolDescription: 'Formats a name',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
        handler: 'return { greeting: "hello " + $input.name }',
      },
    }
    const result = await node.run(nodeData, { name: 'ada' }, makeContext())
    expect(result.output.toolName).toBe('format-name')
    expect(result.output.result).toEqual({ greeting: 'hello ada' })
    expect(result.output.registered).toBe(true)
  })

  it('registers the tool into the run tool registry for downstream agents', async () => {
    const node = new ToolNode()
    const registry: Record<string, IAgentTool> = {}
    const nodeData: INodeData = {
      id: 'n1',
      name: 'toolAgentflow',
      inputs: {
        toolName: 'shout',
        handler: 'return String($input.text ?? $input).toUpperCase()',
      },
    }
    await node.run(nodeData, 'quiet', makeContext(registry))

    const tool = registry['shout']
    expect(tool).toBeDefined()
    expect(tool.name).toBe('shout')
    expect(tool.description).toBe('Custom tool "shout"')
    await expect(tool.handler({ text: 'hi' })).resolves.toBe('HI')
  })

  it('passes input through when no handler is configured (legacy graphs)', async () => {
    const node = new ToolNode()
    const nodeData: INodeData = {
      id: 'n1',
      name: 'toolAgentflow',
      inputs: { toolName: 'legacy-tool', toolInput: 'raw input' },
    }
    const result = await node.run(nodeData, 'upstream', makeContext())
    expect(result.output.toolName).toBe('legacy-tool')
    expect(result.output.result).toEqual({ value: 'raw input' })
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
