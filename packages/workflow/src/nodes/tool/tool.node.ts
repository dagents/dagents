import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Tool node — stub for Plan A.
 *
 * Full implementation (tool execution via @dagents/contracts AgentBackend) is in
 * Plan B. For now, this node validates the tool name is configured and returns
 * a placeholder so graphs containing Tool nodes can be executed linearly.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Tool/Tool.ts
 * (353 lines) — schema preserved, execution stubbed.
 */
export class ToolNode implements INode {
  label = 'Tool'
  name = 'toolAgentflow'
  version = 1
  type = 'Tool'
  category = 'Agent Flows'
  color = '#16A34A'
  inputs = [
    {
      label: 'Tool Name',
      name: 'toolName',
      type: 'string' as const,
      description: 'The name of the tool to invoke',
      required: true,
      acceptVariable: true,
    },
    {
      label: 'Tool Input',
      name: 'toolInput',
      type: 'json' as const,
      description: 'Input to pass to the tool',
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const toolName = nodeData.inputs?.toolName as string
    if (!toolName) {
      throw new Error('Tool node requires a tool name')
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { toolName, toolInput: nodeData.inputs?.toolInput ?? input },
      output: {
        toolName,
        stub: true,
        message: 'Tool execution not implemented in Plan A — see Plan B for full implementation',
      },
      state: options.state,
    }
  }
}
