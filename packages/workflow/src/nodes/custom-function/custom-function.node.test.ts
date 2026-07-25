import { describe, it, expect } from 'vitest'
import { CustomFunctionNode } from './custom-function.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(code: string, input: unknown = {}): INodeData {
  return {
    id: 'n1',
    name: 'customFunctionAgentflow',
    inputs: { functionCode: code, functionInput: input },
  }
}

function makeContext(state: Record<string, unknown> = {}): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state, isLastNode: false }
}

describe('CustomFunctionNode', () => {
  it('executes a simple function and returns its output', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { doubled: $input.value * 2 }'
    const result = await node.run(makeNodeData(code, { value: 21 }), '', makeContext())
    expect(result.output.doubled).toBe(42)
  })

  it('can read from $flow.state', async () => {
    const node = new CustomFunctionNode()
    const code = 'return { greeting: "Hello " + $flow.state.name }'
    const result = await node.run(makeNodeData(code), '', makeContext({ name: 'World' }))
    expect(result.output.greeting).toBe('Hello World')
  })

  it('returns the raw return value wrapped in output', async () => {
    const node = new CustomFunctionNode()
    const code = 'return "plain string"'
    const result = await node.run(makeNodeData(code), '', makeContext())
    expect(result.output).toEqual({ value: 'plain string' })
  })

  it('throws on syntax error', async () => {
    const node = new CustomFunctionNode()
    const code = 'this is not valid javascript'
    await expect(node.run(makeNodeData(code), '', makeContext())).rejects.toThrow()
  })

  it('returns { value: undefined } when function has no return', async () => {
    const node = new CustomFunctionNode()
    const code = 'const x = 1'
    const result = await node.run(makeNodeData(code), '', makeContext())
    // No return → result is undefined, wrapped as { value: undefined }
    expect(result.output).toEqual({ value: undefined })
  })

  it('has correct static metadata', () => {
    const node = new CustomFunctionNode()
    expect(node.name).toBe('customFunctionAgentflow')
    expect(node.type).toBe('CustomFunction')
    expect(node.inputs).toHaveLength(2)
  })
})
