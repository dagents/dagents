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
    const configuredInput = nodeData.inputs?.input

    const resolvedFlowId = resolveVariables(flowId, options.state) as string

    // Fall back to the upstream node's output when no explicit input is
    // configured — the common case is chaining `parent → ExecuteFlow` with
    // the upstream content as the subflow prompt.
    const flowInput =
      configuredInput !== undefined && configuredInput !== null && configuredInput !== ''
        ? configuredInput
        : input

    let output: Record<string, unknown>
    if (options.flowExecutor) {
      output = await options.flowExecutor(resolvedFlowId, flowInput)
    } else {
      // 没有 flowExecutor 时必须失败，不能把输入回显成"子流程的输出" ——
      // 那会让配置了 flowId 的节点看起来成功执行了子流程。宿主总是注入。
      throw new Error(
        'ExecuteFlow node requires a flowExecutor in the execution context (host did not provide one)',
      )
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { flowId, input: flowInput },
      // Spread the subflow output (keeps `content` / `text` passthrough for
      // text-flow downstream) with `output`/`result` aliases on top.
      output: { ...output, output, result: output },
      state: options.state,
    }
  }
}
