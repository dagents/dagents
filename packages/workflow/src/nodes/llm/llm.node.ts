import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * LLM node — calls a large language model with system and user prompts.
 *
 * Resolves template variables in prompts from runtime state before sending
 * to the LLM client.
 *
 * Streaming: when the node is the flow's last node, an SSE streamer is
 * present, and the LLM client implements `chatStream`, the response is
 * streamed token-by-token to the client as it generates (falling back to a
 * single `chat` call otherwise).
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

    const streamable =
      options.isLastNode && options.sseStreamer !== undefined && options.llmClient.chatStream !== undefined

    let text: string
    let usage: import('../../types/index.js').ITokenUsage | undefined
    if (streamable) {
      let accumulated = ''
      for await (const chunk of options.llmClient.chatStream!({ model, messages, temperature })) {
        if (chunk.delta && chunk.delta.length > 0) {
          accumulated += chunk.delta
          options.sseStreamer!.streamTokenEvent(options.chatId, chunk.delta)
        }
        if (chunk.usage) {
          usage = chunk.usage
        }
      }
      text = accumulated
    } else {
      const result = await options.llmClient.chat({ model, messages, temperature })
      text = result.text
      usage = result.usage
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { model, systemPrompt: resolvedSystemPrompt, prompt: resolvedPrompt, temperature },
      output: { text, content: text },
      usage,
    }
  }
}
