import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

export class HumanInputNode implements INode {
  label = 'Human Input'
  name = 'humanInputAgentflow'
  version = 1
  type = 'HumanInput'
  category = 'flow'
  color = '#ec4899'
  inputs = [
    {
      label: 'Prompt',
      name: 'prompt',
      type: 'string' as const,
      default: '',
    },
    {
      label: 'Input Type',
      name: 'inputType',
      type: 'options' as const,
      options: [
        { label: 'Text', name: 'text', description: 'Free text input' },
        { label: 'Select', name: 'select', description: 'Single select from options' },
        { label: 'Confirm', name: 'confirm', description: 'Yes/No confirmation' },
      ],
      default: 'text',
    },
    {
      label: 'Options',
      name: 'options',
      type: 'json' as const,
      default: [],
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const prompt = (nodeData.inputs?.prompt as string) ?? ''
    const inputType = (nodeData.inputs?.inputType as string) ?? 'text'
    const inputOptions = (nodeData.inputs?.options as unknown[]) ?? []

    const resolvedPrompt = resolveVariables(prompt, options.state) as string

    let response: string
    if (options.humanInputResolver) {
      response = await options.humanInputResolver(resolvedPrompt, inputType, inputOptions)
    } else {
      // 没有 resolver 时必须失败，不能把"问题本身"当"人类的回答"继续跑 ——
      // 那等于流程自己替人类确认了自己。宿主（gateway）总是注入 resolver。
      throw new Error(
        'HumanInput node requires a humanInputResolver in the execution context (host did not provide one)',
      )
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { prompt, inputType, options: inputOptions },
      output: {
        response,
        text: response,
      },
      state: options.state,
    }
  }
}
