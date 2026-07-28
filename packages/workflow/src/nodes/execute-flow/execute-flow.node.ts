import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

export class ExecuteFlowNode implements INode {
  label = 'Execute Flow'
  name = 'executeFlowAgentflow'
  version = 1
  type = 'ExecuteFlow'
  category = 'flow'
  color = '#ec4899'
  inputs = [
    {
      label: 'Flow ID',
      name: 'flowId',
      type: 'string' as const,
      default: '',
    },
    {
      label: 'Input',
      name: 'input',
      type: 'json' as const,
      default: {},
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const flowId = (nodeData.inputs?.flowId as string) ?? ''
    const flowInput = (nodeData.inputs?.input as Record<string, unknown>) ?? {}

    const resolvedFlowId = resolveVariables(flowId, options.state) as string

    let output: Record<string, unknown>
    if (options.flowExecutor) {
      output = await options.flowExecutor(resolvedFlowId, flowInput)
    } else {
      output = flowInput
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { flowId, input: flowInput },
      output: {
        output,
        result: output,
      },
      state: options.state,
    }
  }
}
