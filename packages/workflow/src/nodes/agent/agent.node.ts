import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * Agent node — an AI agent that can use tools to accomplish tasks.
 *
 * Current implementation provides a basic LLM call with system prompt.
 * Full tool-calling loop will be added in a follow-up.
 */
export class AgentNode implements INode {
  label = 'Agent'
  name = 'agentAgentflow'
  version = 1
  type = 'Agent'
  category = 'agent'
  color = '#8b5cf6'
  inputs = [
    {
      label: 'Model',
      name: 'model',
      type: 'options' as const,
      required: true,
      default: '',
    },
    {
      label: 'System Prompt',
      name: 'systemPrompt',
      type: 'code' as const,
      rows: 6,
      default: 'You are a helpful assistant.',
    },
    {
      label: 'Tools',
      name: 'tools',
      type: 'options' as const,
      default: [],
    },
    {
      label: 'Max Iterations',
      name: 'maxIterations',
      type: 'number' as const,
      default: 10,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const model = (nodeData.inputs?.model as string) ?? ''
    const systemPrompt = (nodeData.inputs?.systemPrompt as string) ?? 'You are a helpful assistant.'

    const resolvedSystemPrompt = resolveVariables(systemPrompt, options.state) as string

    let userMessage = ''
    if (typeof input === 'string' && input.length > 0) {
      userMessage = input
    } else if (typeof input === 'object' && input !== null && 'text' in input) {
      const inputText = (input as { text: unknown }).text
      if (typeof inputText === 'string') {
        userMessage = inputText
      }
    }

    if (!options.llmClient) {
      throw new Error('LLM client is not available in execution context')
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: resolvedSystemPrompt },
    ]
    if (userMessage.length > 0) {
      messages.push({ role: 'user', content: userMessage })
    }

    const result = await options.llmClient.chat({ model, messages })

    return {
      id: nodeData.id,
      name: this.name,
      input: { model, systemPrompt: resolvedSystemPrompt, userMessage },
      output: { text: result.text, content: result.text },
      usage: result.usage,
    }
  }
}
