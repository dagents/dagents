import { describe, it, expect } from 'vitest'
import {
  mapExecutionState,
  parseFlowData,
  nodeStatusFromExecution,
  latestExecution,
  toFlowDetailView,
  summarizeFlows,
  groupExecutionsByFlow,
  type FlowiseChatflow,
  type FlowiseExecution,
} from './flows'

/**
 * Unit tests for the Flowise → console flow transforms (P1.10.T5).
 *
 * These pin the shape contract the API routes + DAG view rely on, without a
 * gateway: parse/normalize Flowise rows into the console's domain types, map
 * execution states onto node-card statuses, and pick the latest execution.
 */

const sampleFlowData = JSON.stringify({
  nodes: [
    { id: 'n1', type: 'Start', position: { x: 0, y: 0 }, data: { label: '开始' } },
    { id: 'n2', type: 'Agent', position: { x: 200, y: 0 }, data: { label: 'reader' } },
    { id: 'n3', type: 'Direct Reply', position: { x: 400, y: 0 }, data: { label: '结束' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2' },
    { id: 'e2', source: 'n2', target: 'n3', data: { label: 'ok' } },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
})

describe('mapExecutionState', () => {
  it('maps Flowise states to node-card statuses', () => {
    expect(mapExecutionState('INPROGRESS')).toBe('running')
    expect(mapExecutionState('FINISHED')).toBe('done')
    expect(mapExecutionState('ERROR')).toBe('failed')
    expect(mapExecutionState('TERMINATED')).toBe('failed')
    expect(mapExecutionState('TIMEOUT')).toBe('failed')
    expect(mapExecutionState('STOPPED')).toBe('paused')
  })

  it('maps unknown / missing states to idle', () => {
    expect(mapExecutionState(undefined)).toBe('idle')
    expect(mapExecutionState('WHATEVER')).toBe('idle')
  })
})

describe('parseFlowData', () => {
  it('parses a valid flowData JSON into nodes + edges', () => {
    const dag = parseFlowData(sampleFlowData)
    expect(dag.nodes).toHaveLength(3)
    expect(dag.nodes[0]).toMatchObject({ id: 'n1', type: 'Start' })
    expect(dag.edges).toHaveLength(2)
    // the sample nests the edge label in data.label (Flowise's shape)
    expect(dag.edges[1]!.data?.label).toBe('ok')
  })

  it('reads an edge label at top-level OR nested in data.label', () => {
    const topLevel = parseFlowData(
      JSON.stringify({ nodes: [], edges: [{ id: 'e', source: 'a', target: 'b', label: 'top' }] }),
    )
    expect(topLevel.edges[0]!.label).toBe('top')
    const nested = parseFlowData(
      JSON.stringify({ nodes: [], edges: [{ id: 'e', source: 'a', target: 'b', data: { label: 'nested' } }] }),
    )
    expect(nested.edges[0]!.data?.label).toBe('nested')
  })

  it('returns an empty DAG for missing / malformed flowData', () => {
    expect(parseFlowData(undefined)).toEqual({ nodes: [], edges: [] })
    expect(parseFlowData(null)).toEqual({ nodes: [], edges: [] })
    expect(parseFlowData('not json')).toEqual({ nodes: [], edges: [] })
    expect(parseFlowData('{}')).toEqual({ nodes: [], edges: [] })
  })
})

describe('nodeStatusFromExecution', () => {
  it('takes the LAST entry per nodeId (most recent status)', () => {
    const exec: FlowiseExecution = {
      id: 'ex1',
      agentflowId: 'f1',
      sessionId: 's1',
      state: 'INPROGRESS',
      executionData: [
        { nodeId: 'n1', status: 'INPROGRESS' },
        { nodeId: 'n2', status: 'INPROGRESS' },
        { nodeId: 'n1', status: 'FINISHED' }, // n1 advanced → done
      ],
      createdDate: '2026-07-09T00:00:00Z',
    }
    expect(nodeStatusFromExecution(exec)).toEqual({ n1: 'done', n2: 'running' })
  })

  it('parses executionData when it is a JSON string', () => {
    const exec: FlowiseExecution = {
      id: 'ex1',
      agentflowId: 'f1',
      sessionId: 's1',
      state: 'FINISHED',
      executionData: JSON.stringify([{ nodeId: 'n1', status: 'FINISHED' }]),
      createdDate: '2026-07-09T00:00:00Z',
    }
    expect(nodeStatusFromExecution(exec)).toEqual({ n1: 'done' })
  })

  it('returns {} for missing / malformed executionData', () => {
    const base = { id: 'ex1', agentflowId: 'f1', sessionId: 's1', state: 'FINISHED', createdDate: '2026-07-09T00:00:00Z' } as const
    expect(nodeStatusFromExecution({ ...base, executionData: undefined })).toEqual({})
    expect(nodeStatusFromExecution({ ...base, executionData: 'not json' })).toEqual({})
    expect(nodeStatusFromExecution({ ...base, executionData: null })).toEqual({})
  })
})

describe('latestExecution', () => {
  it('picks the execution with the highest updatedDate', () => {
    const execs: FlowiseExecution[] = [
      { id: 'old', agentflowId: 'f', sessionId: 's', state: 'FINISHED', createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-01T00:00:00Z' },
      { id: 'new', agentflowId: 'f', sessionId: 's', state: 'INPROGRESS', createdDate: '2026-07-09T00:00:00Z', updatedDate: '2026-07-09T00:00:00Z' },
    ]
    expect(latestExecution(execs)?.id).toBe('new')
  })

  it('falls back to createdDate when updatedDate is absent', () => {
    const execs: FlowiseExecution[] = [
      { id: 'a', agentflowId: 'f', sessionId: 's', state: 'FINISHED', createdDate: '2026-07-05T00:00:00Z' },
      { id: 'b', agentflowId: 'f', sessionId: 's', state: 'FINISHED', createdDate: '2026-07-01T00:00:00Z' },
    ]
    expect(latestExecution(execs)?.id).toBe('a')
  })

  it('returns undefined for an empty list', () => {
    expect(latestExecution([])).toBeUndefined()
  })
})

describe('toFlowDetailView', () => {
  const flow: FlowiseChatflow = {
    id: 'f1',
    name: '论文复现',
    type: 'AGENTFLOW',
    flowData: sampleFlowData,
    createdDate: '2026-07-01T00:00:00Z',
    updatedDate: '2026-07-09T00:00:00Z',
  }

  it('paints node statuses from the latest execution', () => {
    const execs: FlowiseExecution[] = [
      {
        id: 'ex1',
        agentflowId: 'f1',
        sessionId: 's1',
        state: 'INPROGRESS',
        executionData: [
          { nodeId: 'n1', status: 'FINISHED' },
          { nodeId: 'n2', status: 'INPROGRESS' },
        ],
        createdDate: '2026-07-09T00:00:00Z',
        updatedDate: '2026-07-09T00:00:00Z',
      },
    ]
    const view = toFlowDetailView(flow, execs, 'abc123')
    expect(view.nodes).toHaveLength(3)
    expect(view.nodes.find((n) => n.id === 'n1')?.status).toBe('done')
    expect(view.nodes.find((n) => n.id === 'n2')?.status).toBe('running')
    // n3 was not touched by the execution → idle
    expect(view.nodes.find((n) => n.id === 'n3')?.status).toBe('idle')
    expect(view.status).toBe('running')
    expect(view.latestExecutionId).toBe('ex1')
    expect(view.versionHash).toBe('abc123')
  })

  it('uses node data.label, falling back to the id when absent', () => {
    const flowNoLabels: FlowiseChatflow = {
      ...flow,
      flowData: JSON.stringify({
        nodes: [
          { id: 'x1', position: { x: 0, y: 0 }, data: {} },
          { id: 'x2', position: { x: 0, y: 0 } },
        ],
        edges: [],
      }),
    }
    const view = toFlowDetailView(flowNoLabels, [])
    expect(view.nodes.find((n) => n.id === 'x1')?.label).toBe('x1')
    expect(view.nodes.find((n) => n.id === 'x2')?.label).toBe('x2')
  })

  it('synthesizes edge ids when Flowise omits them', () => {
    const flowNoEdgeIds: FlowiseChatflow = {
      ...flow,
      flowData: JSON.stringify({
        nodes: [],
        edges: [{ source: 'a', target: 'b' }],
      }),
    }
    const view = toFlowDetailView(flowNoEdgeIds, [])
    expect(view.edges[0]!.id).toBe('e-a-b-0')
  })

  it('reports idle status + empty nodeMetrics when there are no executions', () => {
    const view = toFlowDetailView(flow, [])
    expect(view.status).toBe('idle')
    expect(view.latestExecutionId).toBeUndefined()
    expect(view.nodeMetrics).toEqual({})
    // nodes still render, all idle
    expect(view.nodes.every((n) => n.status === 'idle')).toBe(true)
  })
})

describe('summarizeFlows + groupExecutionsByFlow', () => {
  const flows: FlowiseChatflow[] = [
    { id: 'f1', name: 'A', type: 'AGENTFLOW', flowData: sampleFlowData, createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-09T00:00:00Z' },
    { id: 'f2', name: 'B', type: 'AGENTFLOW', flowData: '{}', createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-08T00:00:00Z' },
  ]
  const execs: FlowiseExecution[] = [
    { id: 'e1', agentflowId: 'f1', sessionId: 's', state: 'INPROGRESS', createdDate: '2026-07-09T00:00:00Z', updatedDate: '2026-07-09T00:00:00Z' },
  ]

  it('groups executions by flow id', () => {
    expect(groupExecutionsByFlow(execs)).toEqual({ f1: execs })
  })

  it('colors each flow by its latest execution and counts nodes', () => {
    const grouped = groupExecutionsByFlow(execs)
    const summary = summarizeFlows(flows, grouped)
    expect(summary).toHaveLength(2)
    expect(summary[0]).toMatchObject({ id: 'f1', name: 'A', status: 'running', nodeCount: 3 })
    expect(summary[1]).toMatchObject({ id: 'f2', name: 'B', status: 'idle', nodeCount: 0 })
  })

  it('derives list-page fidelity fields: archived / runCount / latestRunId / versionHash / owner (M2.1)', () => {
    // f1 running (1 execution, has a latest run id), f2 idle (0 executions),
    // plus a failed/paused flow exercises the `archived` derivation.
    const archFlows: FlowiseChatflow[] = [
      { id: 'f1', name: 'A', type: 'AGENTFLOW', flowData: sampleFlowData, createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-09T00:00:00Z' },
      { id: 'f2', name: 'B', type: 'AGENTFLOW', flowData: '{}', createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-08T00:00:00Z' },
      { id: 'f3', name: 'C', type: 'AGENTFLOW', flowData: '{}', createdDate: '2026-07-01T00:00:00Z', updatedDate: '2026-07-08T00:00:00Z' },
    ]
    const archExecs: FlowiseExecution[] = [
      { id: 'e1', agentflowId: 'f1', sessionId: 's1', state: 'INPROGRESS', createdDate: '2026-07-09T00:00:00Z', updatedDate: '2026-07-09T00:00:00Z' },
      { id: 'e0', agentflowId: 'f1', sessionId: 's0', state: 'FINISHED', createdDate: '2026-07-08T00:00:00Z', updatedDate: '2026-07-08T00:00:00Z' },
      { id: 'e3', agentflowId: 'f3', sessionId: 's3', state: 'TERMINATED', createdDate: '2026-07-08T00:00:00Z', updatedDate: '2026-07-08T00:00:00Z' },
    ]
    const grouped = groupExecutionsByFlow(archExecs)
    const summary = summarizeFlows(archFlows, grouped, { f1: 'abc123' })
    // f1: running, 2 executions, latest run = e1, version hash threaded
    expect(summary[0]).toMatchObject({
      id: 'f1', status: 'running', archived: false, runCount: 2, latestRunId: 'e1', versionHash: 'abc123', owner: null,
    })
    // f2: idle (no executions), archived false, runCount 0, no latest run
    expect(summary[1]).toMatchObject({
      id: 'f2', status: 'idle', archived: false, runCount: 0, versionHash: '',
    })
    expect(summary[1].latestRunId).toBeUndefined()
    // f3: TERMINATED → failed → archived true (matches design agentflows.html:238)
    expect(summary[2]).toMatchObject({ id: 'f3', status: 'failed', archived: true, runCount: 1 })
  })
})
