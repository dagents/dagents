import { describe, it, expect } from 'vitest'
import { StartNode } from './start.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(variables: Record<string, unknown> = {}): INodeData {
  return {
    id: 'n1',
    name: 'startAgentflow',
    inputs: { variables },
  }
}

function makeContext(opts: Partial<IExecutionContext> = {}): IExecutionContext {
  return {
    chatId: 'c1',
    runId: 'r1',
    state: {},
    isLastNode: false,
    ...opts,
  }
}

describe('StartNode', () => {
  it('returns variables as output and state', async () => {
    const node = new StartNode()
    const variables = { foo: 'bar', count: 42 }
    const context = makeContext()
    const result = await node.run(makeNodeData(variables), '', context)

    expect(result.output.variables).toEqual(variables)
    expect(result.output.foo).toBe('bar')
    expect(result.output.count).toBe(42)
    expect(result.state).toEqual(variables)
    expect(result.id).toBe('n1')
    expect(result.name).toBe('startAgentflow')
  })

  it('merges variables into runtime state', async () => {
    const node = new StartNode()
    const variables = { user: 'alice', role: 'admin' }
    const context = makeContext()
    await node.run(makeNodeData(variables), '', context)

    expect(context.state.user).toBe('alice')
    expect(context.state.role).toBe('admin')
  })

  it('handles empty variables', async () => {
    const node = new StartNode()
    const context = makeContext()
    const result = await node.run(makeNodeData({}), '', context)

    expect(result.output.variables).toEqual({})
    expect(result.state).toEqual({})
    expect(Object.keys(result.output)).toContain('variables')
  })

  it('handles missing variables input', async () => {
    const node = new StartNode()
    const context = makeContext()
    const result = await node.run({ id: 'n1', name: 'startAgentflow' }, '', context)

    expect(result.output.variables).toEqual({})
    expect(result.state).toEqual({})
  })

  it('has correct static metadata', () => {
    const node = new StartNode()
    expect(node.label).toBe('Start')
    expect(node.name).toBe('startAgentflow')
    expect(node.version).toBe(1)
    expect(node.type).toBe('Start')
    expect(node.category).toBe('start')
    expect(node.color).toBe('#10b981')
    expect(node.inputs).toHaveLength(1)
    expect(node.inputs[0].name).toBe('variables')
    expect(node.inputs[0].type).toBe('json')
  })
})
