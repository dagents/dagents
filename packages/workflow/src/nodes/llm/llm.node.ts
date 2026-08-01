import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * LLM node — calls a large language model with system and user prompts.
 *
 * Resolves template variables in prompts from runtime state before sending
 * to the LLM client.
 */
export class LLMNode implements INode {
  label = 'LLM'
  name = 'llmAgentflow'
  version = 1
  type = 'LLM'
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
      rows: 4,
      default: '',
    },
    {
      label: 'Prompt',
      name: 'prompt',
      type: 'code' as const,
      rows: 4,
      required: true,
      default: '',
    },
    {
      label: 'Temperature',
      name: 'temperature',
      type: 'number' as const,
      default: 0.7,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const model = (nodeData.inputs?.model as string) ?? ''
    const systemPrompt = (nodeData.inputs?.systemPrompt as string) ?? ''
    const prompt = (nodeData.inputs?.prompt as string) ?? ''
    const temperature = (nodeData.inputs?.temperature as number) ?? 0.7

    const resolvedSystemPrompt = resolveVariables(systemPrompt, options.state) as string
    let resolvedPrompt = resolveVariables(prompt, options.state) as string

    if (typeof input === 'string' && input.length > 0) {
      resolvedPrompt = `${resolvedPrompt}\n\n${input}`
    } else if (typeof input === 'object' && input !== null && 'text' in input) {
      const inputText = (input as { text: unknown }).text
      if (typeof inputText === 'string' && inputText.length > 0) {
        resolvedPrompt = `${resolvedPrompt}\n\n${inputText}`
      }
    }

    if (!options.llmClient) {
      throw new Error('LLM client is not available in execution context')
    }

    const messages: Array<{ role: string; content: string }> = []
    if (resolvedSystemPrompt.length > 0) {
      messages.push({ role: 'system', content: resolvedSystemPrompt })
    }
    messages.push({ role: 'user', content: resolvedPrompt })

    const result = await options.llmClient.chat({ model, messages, temperature })

    return {
      id: nodeData.id,
      name: this.name,
      input: { model, systemPrompt: resolvedSystemPrompt, prompt: resolvedPrompt, temperature },
      output: { text: result.text, content: result.text },
      usage: result.usage,
    }
  }
}
