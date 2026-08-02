import { describe, it, expect } from 'vitest'
import { CANVAS_NODES } from '../nodes/node-registry-canvas.js'
import { convertNodeToFlowiseSchema } from './convert-node.js'

describe('convertNodeToFlowiseSchema', () => {
  it('maps input types correctly', () => {
    const node = CANVAS_NODES.find((n) => n.name === 'directReplyAgentflow')!
    const schema = convertNodeToFlowiseSchema(node)
    expect(schema.type).toBe('agentflow')
    expect(schema.name).toBe('directReplyAgentflow')
    const inputs = schema.inputs as Array<{ type: string; name: string }>
    expect(inputs.find((i) => i.name === 'text')?.type).toBe('code')
  })

  it('maps outputs', () => {
    const node = CANVAS_NODES.find((n) => n.name === 'conditionAgentflow')!
    const schema = convertNodeToFlowiseSchema(node)
    const outputs = schema.outputs as Array<{ name: string; label: string }>
    expect(outputs.map((o) => o.name)).toContain('true')
    expect(outputs.map((o) => o.name)).toContain('false')
  })

  it('converts platform agent agentId to dropdown when options provided', () => {
    const node = CANVAS_NODES.find((n) => n.name === 'platformAgentAgentflow')!
    const schema = convertNodeToFlowiseSchema(node, [
      { name: 'agent-1', label: 'Agent One' },
    ])
    const inputs = schema.inputs as Array<{ type: string; name: string; options?: unknown[] }>
    const agentIdInput = inputs.find((i) => i.name === 'agentId')!
    expect(agentIdInput.type).toBe('options')
    expect(agentIdInput.options).toHaveLength(1)
  })

  it('falls back to string for unknown input types', () => {
    const node = {
      ...CANVAS_NODES.find((n) => n.name === 'directReplyAgentflow')!,
      inputs: [
        {
          label: 'Magic',
          name: 'magic',
          type: 'file' as const,
          default: '',
        },
      ],
    }
    const schema = convertNodeToFlowiseSchema(node)
    const inputs = schema.inputs as Array<{ type: string }>
    expect(inputs[0].type).toBe('string')
  })
})
