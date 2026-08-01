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

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const variables = (nodeData.inputs?.variables as Record<string, unknown>) ?? {}

    // The workflow input — either the runtime input passed to execute(), or
    // a configured default on the node's data.input field. Put it in state as
    // `input` so downstream nodes can resolve {{input}} in their templates.
    const inputText =
      typeof input === 'string' && input.length > 0
        ? input
        : typeof nodeData.inputs?.input === 'string'
          ? nodeData.inputs.input
          : ''

    for (const [key, value] of Object.entries(variables)) {
      options.state[key] = value
    }
    if (inputText) {
      options.state['input'] = inputText
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { input: inputText, variables },
      // `content` follows the Flowise mergeInputs convention so the next node
      // receives the input text as a string when there's a single downstream edge.
      output: { variables, ...variables, content: inputText },
      state: { ...variables, ...(inputText ? { input: inputText } : {}) },
    }
  }
}
