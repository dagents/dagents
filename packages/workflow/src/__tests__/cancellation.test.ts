/**
 * Cancellation semantics of DagExecutor (execution-cancellation spec D3):
 * an aborted `ExecuteOptions.signal` must surface as
 * `ExecutionResult.status = 'cancelled'` — the enum value existed since the
 * beginning but was never produced. Covers pre-aborted runs and mid-run
 * aborts (checkpoint at the next wave boundary).
 */
import { describe, it, expect } from 'vitest'
import { DagExecutor } from '../engine/executor.js'
import { NodeRegistry } from '../engine/node-registry.js'
import type { INode, INodeData, INodeOutput, IExecutionContext } from '../types/index.js'
import type { FlowData } from '../types/flow.js'

/** A node that takes `ms` to run — gives the test a window to abort mid-wave. */
function makeSlowNode(name: string, ms: number): INode {
  return {
    label: name,
    name,
    version: 1,
    type: name,
    category: 'Test',
    color: '#000',
    inputs: [],
    async run(nodeData: INodeData, _input: unknown, _options: IExecutionContext): Promise<INodeOutput> {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { id: nodeData.id, name, input: {}, output: { content: `${name}-done` } }
    },
  }
}

const twoNodeFlow = (): FlowData => ({
  nodes: [
    { id: 'n1', data: { name: 'slowA' } },
    { id: 'n2', data: { name: 'slowB' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
})

function makeExecutor(): DagExecutor {
  const registry = new NodeRegistry()
  registry.register(makeSlowNode('slowA', 30))
  registry.register(makeSlowNode('slowB', 30))
  return new DagExecutor(registry)
}

describe('DagExecutor cancellation', () => {
  it('pre-aborted signal → status=cancelled, no nodes executed', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await makeExecutor().execute(twoNodeFlow(), 'in', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      signal: controller.signal,
    })
    expect(result.status).toBe('cancelled')
    expect(result.error).toContain('cancelled')
    expect(result.executedNodes).toHaveLength(0)
  })

  it('mid-run abort → status=cancelled at the wave boundary', async () => {
    const controller = new AbortController()
    const executing = makeExecutor().execute(twoNodeFlow(), 'in', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
      signal: controller.signal,
    })
    // Abort while wave 1 (slowA) is in flight; slowA completes, the scheduler
    // then sees the aborted signal before scheduling wave 2.
    setTimeout(() => controller.abort(), 10)
    const result = await executing
    expect(result.status).toBe('cancelled')
    expect(result.error).toContain('cancelled')
    // slowA finished before the abort was observed — its record stands.
    expect(result.executedNodes.length).toBeLessThanOrEqual(1)
  })

  it('no abort → still completes normally', async () => {
    const result = await makeExecutor().execute(twoNodeFlow(), 'in', {
      chatId: 'c1',
      runId: 'r1',
      state: {},
      isLastNode: true,
    })
    expect(result.status).toBe('success')
    expect(result.executedNodes).toHaveLength(2)
  })
})
