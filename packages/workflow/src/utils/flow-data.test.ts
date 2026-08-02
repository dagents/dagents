import { describe, it, expect } from 'vitest'
import { parseFlowData, flowDataSchema } from './flow-data.js'

describe('parseFlowData', () => {
  it('returns empty DAG for null/undefined/empty input', () => {
    expect(parseFlowData(null)).toEqual({ nodes: [], edges: [] })
    expect(parseFlowData(undefined)).toEqual({ nodes: [], edges: [] })
    expect(parseFlowData('')).toEqual({ nodes: [], edges: [] })
  })

  it('parses valid flowData JSON', () => {
    const data = {
      nodes: [{ id: 'a', position: { x: 0, y: 0 }, type: 'startAgentflow' }],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      viewport: { x: 10, y: 20, zoom: 1.5 },
    }
    expect(parseFlowData(JSON.stringify(data))).toEqual({
      ...data,
      nodes: [{ ...data.nodes[0], data: {} }],
    })
  })

  it('defaults missing node data to empty object', () => {
    const result = parseFlowData(JSON.stringify({ nodes: [{ id: 'a', position: { x: 0, y: 0 } }] }))
    expect(result.nodes[0]?.data).toEqual({})
  })

  it('defaults missing nodes/edges arrays to empty', () => {
    expect(parseFlowData(JSON.stringify({ viewport: { x: 0, y: 0, zoom: 1 } }))).toEqual({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    })
  })

  it('preserves unknown node data fields', () => {
    const data = {
      nodes: [
        {
          id: 'a',
          position: { x: 0, y: 0 },
          data: { label: 'Start', inputs: { model: 'gpt-4' } },
        },
      ],
      edges: [],
    }
    const parsed = parseFlowData(JSON.stringify(data))
    expect(parsed.nodes[0]?.data).toEqual(data.nodes[0].data)
  })

  it('parses nodes with null handles and no position', () => {
    const data = {
      nodes: [{ id: 'a', data: {} }],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: null, targetHandle: null }],
    }
    const parsed = parseFlowData(JSON.stringify(data))
    expect(parsed.nodes[0]?.position).toBeUndefined()
    expect(parsed.edges[0]?.sourceHandle).toBeNull()
    expect(parsed.edges[0]?.targetHandle).toBeNull()
  })

  it('falls back to empty DAG for malformed JSON', () => {
    expect(parseFlowData('not json')).toEqual({ nodes: [], edges: [] })
  })

  it('falls back to empty DAG for invalid shape', () => {
    expect(parseFlowData(JSON.stringify({ nodes: 'bad' }))).toEqual({ nodes: [], edges: [] })
  })
})

describe('flowDataSchema', () => {
  it('rejects non-object input', () => {
    expect(flowDataSchema.safeParse(42).success).toBe(false)
  })
})
