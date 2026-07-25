import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Loop node — set a loop count for the engine to repeat downstream nodes.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Loop/Loop.ts
 * (154 lines). In Plan A, this node only validates + caps the loop count.
 * The actual loop execution (repeating the sub-path N times) is in Plan B's
 * executor.
 *
 * MAX_LOOP_COUNT defaults to 10 (matches Flowise's buildAgentflow.ts:174
 * `process.env.MAX_LOOP_COUNT ?? 10`).
 */
const MAX_LOOP_COUNT = Number(process.env.MAX_LOOP_COUNT ?? 10)

export class LoopNode implements INode {
  label = 'Loop'
  name = 'loopAgentflow'
  version = 1
  type = 'Loop'
  category = 'Agent Flows'
  color = '#9C89B8'
  inputs = [
    {
      label: 'Loop Count',
      name: 'loopCount',
      type: 'number' as const,
      description: `Number of times to loop (max ${MAX_LOOP_COUNT})`,
      acceptVariable: true,
      default: 1,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const raw = nodeData.inputs?.loopCount
    const count = typeof raw === 'number' ? raw : parseInt(String(raw), 10)

    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Loop count must be at least 1 (got: ${raw})`)
    }

    const loopCount = Math.min(count, MAX_LOOP_COUNT)

    return {
      id: nodeData.id,
      name: this.name,
      input: { loopCount: raw },
      output: { loopCount },
      state: options.state,
    }
  }
}
