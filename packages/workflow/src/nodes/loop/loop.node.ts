import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Loop node — repeats its loop body N times.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Loop/Loop.ts.
 * The node itself validates + caps the loop count and exposes the optional
 * early-exit condition; the DagExecutor (see `planLoopBody` / `runLoopBody`)
 * detects the controller output and re-executes the sub-DAG reachable from
 * the node's `loop` output anchor once per iteration, feeding each iteration
 * the previous iteration's final output. An optional `condition` (a JS
 * expression over `$flow.state`, e.g. `$flow.state.done === true`) breaks the
 * loop early before a new iteration starts.
 *
 * MAX_LOOP_COUNT defaults to 10 (matches Flowise's buildAgentflow.ts
 * `process.env.MAX_LOOP_COUNT ?? 10`). A non-numeric / <1 env value falls
 * back to 10 — NaN here would silently run ZERO iterations and report success.
 */
const MAX_LOOP_COUNT = (() => {
  const n = Number(process.env.MAX_LOOP_COUNT ?? 10)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10
})()

export class LoopNode implements INode {
  label = 'Loop'
  name = 'loopAgentflow'
  version = 1
  type = 'Loop'
  category = 'flow'
  color = '#ec4899'
  inputs = [
    {
      label: 'Loop Count',
      name: 'loopCount',
      type: 'number' as const,
      description: `Number of times to loop (max ${MAX_LOOP_COUNT})`,
      acceptVariable: true,
      default: 1,
    },
    {
      label: 'Max Iterations',
      name: 'maxIterations',
      type: 'number' as const,
      description: `Fallback loop count when Loop Count is unset (max ${MAX_LOOP_COUNT})`,
      default: 10,
    },
    {
      label: 'Break Condition',
      name: 'condition',
      type: 'code' as const,
      description:
        'Optional JS expression evaluated over $flow.state before each subsequent iteration — truthy breaks the loop (e.g. $flow.state.done === true)',
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const raw = nodeData.inputs?.loopCount ?? nodeData.inputs?.maxIterations
    const count = typeof raw === 'number' ? raw : parseInt(String(raw), 10)

    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Loop count must be at least 1 (got: ${raw})`)
    }

    const loopCount = Math.min(count, MAX_LOOP_COUNT)

    return {
      id: nodeData.id,
      name: this.name,
      input: { loopCount: raw },
      output: { loopCount, condition: nodeData.inputs?.condition ?? undefined },
      state: options.state,
    }
  }
}
