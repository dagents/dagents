import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Start node — the entry point of an agent flow.
 *
 * Initializes the runtime state with configured variables and passes them
 * downstream as output.
 */
export class StartNode implements INode {
  label = 'Start'
  name = 'startAgentflow'
  version = 1
  type = 'Start'
  category = 'start'
  color = '#10b981'
  inputs = [
    {
      label: 'Variables',
      name: 'variables',
      type: 'json' as const,
      default: {},
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const variables = (nodeData.inputs?.variables as Record<string, unknown>) ?? {}

    for (const [key, value] of Object.entries(variables)) {
      options.state[key] = value
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: {},
      output: { variables, ...variables },
      state: variables,
    }
  }
}
