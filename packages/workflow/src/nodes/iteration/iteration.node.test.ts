import { describe, it, expect } from 'vitest'
import { IterationNode } from './iteration.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(input: unknown): INodeData {
  return {
    id: 'n1',
    name: 'iterationAgentflow',
    inputs: { iterationInput: input },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('IterationNode', () => {
  it('parses a JSON string array', async () => {
    const node = new IterationNode()
    const result = await node.run(makeNodeData('["a", "b", "c"]'), '', makeContext())
    expect(result.output.iterationInput).toEqual(['a', 'b', 'c'])
  })

  it('passes through an already-parsed array', async () => {
    const node = new IterationNode()
    const result = await node.run(makeNodeData([1, 2, 3]), '', makeContext())
    expect(result.output.iterationInput).toEqual([1, 2, 3])
  })

  it('throws on non-array input', async () => {
    const node = new IterationNode()
    await expect(node.run(makeNodeData('not an array'), '', makeContext())).rejects.toThrow(/invalid input array/i)
  })

  it('throws on empty string', async () => {
    const node = new IterationNode()
    await expect(node.run(makeNodeData(''), '', makeContext())).rejects.toThrow(/invalid input array/i)
  })

  it('handles JSON with escaped backslashes', async () => {
    const node = new IterationNode()
    // Simulate a string that has redundant backslashes (Flowise pattern)
    const result = await node.run(makeNodeData('[\\"a\\", \\"b\\"]'), '', makeContext())
    expect(result.output.iterationInput).toEqual(['a', 'b'])
  })

  it('has correct static metadata', () => {
    const node = new IterationNode()
    expect(node.name).toBe('iterationAgentflow')
    expect(node.type).toBe('Iteration')
    expect(node.inputs[0].name).toBe('items')
  })

  it('accepts the canvas "items" field name', async () => {
    const node = new IterationNode()
    const result = await node.run(
      { id: 'n1', name: 'iterationAgentflow', inputs: { items: '["x", "y"]' } },
      '',
      makeContext(),
    )
    expect(result.output.iterationInput).toEqual(['x', 'y'])
  })
})
