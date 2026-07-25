import { describe, it, expect } from 'vitest'
import { NodeRegistry } from '../engine/node-registry.js'
import type { INode } from '../types/node.js'

// A stub node for testing — real nodes are registered in nodes/index.ts.
const stubNode: INode = {
  label: 'Stub',
  name: 'stubNode',
  version: 1,
  type: 'Stub',
  category: 'Test',
  color: '#000000',
  inputs: [],
  async run() {
    return { id: 'stub', name: 'stubNode', input: {}, output: {} }
  },
}

describe('NodeRegistry', () => {
  it('registers and looks up a node by name', () => {
    const reg = new NodeRegistry()
    reg.register(stubNode)
    expect(reg.get('stubNode')).toBe(stubNode)
  })

  it('returns undefined for unknown node name', () => {
    const reg = new NodeRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('lists all registered node names', () => {
    const reg = new NodeRegistry()
    reg.register(stubNode)
    reg.register({ ...stubNode, name: 'anotherStub' })
    const names = reg.list()
    expect(names).toContain('stubNode')
    expect(names).toContain('anotherStub')
    expect(names).toHaveLength(2)
  })

  it('throws when registering a duplicate name', () => {
    const reg = new NodeRegistry()
    reg.register(stubNode)
    expect(() => reg.register(stubNode)).toThrow(/already registered/)
  })

  it('registerMany adds multiple nodes at once', () => {
    const reg = new NodeRegistry()
    reg.registerMany([stubNode, { ...stubNode, name: 'second' }])
    expect(reg.list()).toHaveLength(2)
  })
})
