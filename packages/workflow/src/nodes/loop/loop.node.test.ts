import { describe, it, expect } from 'vitest'
import { LoopNode } from './loop.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(loopCount: unknown): INodeData {
  return {
    id: 'n1',
    name: 'loopAgentflow',
    inputs: { loopCount },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('LoopNode', () => {
  it('accepts a positive integer loop count', async () => {
    const node = new LoopNode()
    const result = await node.run(makeNodeData(5), '', makeContext())
    expect(result.output.loopCount).toBe(5)
  })

  it('accepts a string number and parses it', async () => {
    const node = new LoopNode()
    const result = await node.run(makeNodeData('3'), '', makeContext())
    expect(result.output.loopCount).toBe(3)
  })

  it('throws on zero', async () => {
    const node = new LoopNode()
    await expect(node.run(makeNodeData(0), '', makeContext())).rejects.toThrow(/loop count.*must be.*1/i)
  })

  it('throws on negative', async () => {
    const node = new LoopNode()
    await expect(node.run(makeNodeData(-1), '', makeContext())).rejects.toThrow(/loop count/i)
  })

  it('throws on non-numeric', async () => {
    const node = new LoopNode()
    await expect(node.run(makeNodeData('abc'), '', makeContext())).rejects.toThrow(/loop count/i)
  })

  it('caps at MAX_LOOP_COUNT (10)', async () => {
    const node = new LoopNode()
    const result = await node.run(makeNodeData(100), '', makeContext())
    expect(result.output.loopCount).toBe(10)
  })

  it('has correct static metadata', () => {
    const node = new LoopNode()
    expect(node.name).toBe('loopAgentflow')
    expect(node.type).toBe('Loop')
    expect(node.inputs[0].name).toBe('loopCount')
  })
})
