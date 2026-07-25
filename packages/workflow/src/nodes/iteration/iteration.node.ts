import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Iteration node — parse an array input for the engine to iterate over.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Iteration/Iteration.ts
 * (75 lines). In Plan A, this node only parses + passes through the array.
 * The actual iteration logic (repeating downstream nodes N times) is in
 * Plan B's executor branch/loop handling.
 *
 * Flowise dependencies removed:
 *   - `parseJsonBody` from `../../../src/utils` → inline `safeParseJson`
 *   - `ICommonObject` → `IExecutionContext`
 */
export class IterationNode implements INode {
  label = 'Iteration'
  name = 'iterationAgentflow'
  version = 1
  type = 'Iteration'
  category = 'Agent Flows'
  color = '#9C89B8'
  inputs = [
    {
      label: 'Array Input',
      name: 'iterationInput',
      type: 'string' as const,
      description: 'The input array to iterate over',
      acceptVariable: true,
      rows: 4,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const iterationInput = nodeData.inputs?.iterationInput

    const safeParseJson = (str: string): unknown => {
      try {
        return JSON.parse(str)
      } catch {
        try {
          // Try parsing after cleaning redundant backslashes
          return JSON.parse(str.replace(/\\(["'[\]{}])/g, '$1'))
        } catch {
          // Both parses failed — return the original string so the array
          // check below throws a clean "Invalid input array" error.
          return str
        }
      }
    }

    const iterationInputArray =
      typeof iterationInput === 'string' && iterationInput !== ''
        ? safeParseJson(iterationInput)
        : iterationInput

    if (!iterationInputArray || !Array.isArray(iterationInputArray)) {
      throw new Error('Invalid input array')
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { iterationInput: iterationInputArray },
      output: { iterationInput: iterationInputArray },
      state: options.state,
    }
  }
}
