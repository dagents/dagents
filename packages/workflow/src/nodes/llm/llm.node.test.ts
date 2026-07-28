import { describe, it, expect, vi } from 'vitest'
import { LLMNode } from './llm.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeMockLlmClient(text: string) {
  return {
    chat: vi.fn().mockResolvedValue({ text }),
  }
}

function makeNodeData(opts: Partial<{
  model: string
  systemPrompt: string
  prompt: string
  temperature: number
}> = {}): INodeData {
  return {
    id: 'n1',
    name: 'llmAgentflow',
    inputs: {
      model: opts.model ?? 'gpt-4',
      systemPrompt: opts.systemPrompt ?? '',
      prompt: opts.prompt ?? 'Hello',
      temperature: opts.temperature ?? 0.7,
    },
  }
}

function makeContext(opts: Partial<IExecutionContext> = {}): IExecutionContext {
  return {
    chatId: 'c1',
    runId: 'r1',
    state: {},
    isLastNode: false,
    ...opts,
  }
}

describe('LLMNode', () => {
  it('calls LLM and returns text as output', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('Hello there!')
    const context = makeContext({ llmClient: mockClient })

    const result = await node.run(makeNodeData({ prompt: 'Hi' }), '', context)

    expect(mockClient.chat).toHaveBeenCalledTimes(1)
    expect(result.output.text).toBe('Hello there!')
    expect(result.output.content).toBe('Hello there!')
    expect(result.id).toBe('n1')
    expect(result.name).toBe('llmAgentflow')
  })

  it('includes system prompt in messages when provided', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(
      makeNodeData({ systemPrompt: 'You are helpful.', prompt: 'Hi' }),
      '',
      context,
    )

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages).toHaveLength(2)
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe('You are helpful.')
    expect(callArgs.messages[1].role).toBe('user')
    expect(callArgs.messages[1].content).toBe('Hi')
  })

  it('omits system prompt when empty', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(makeNodeData({ systemPrompt: '', prompt: 'Hi' }), '', context)

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages).toHaveLength(1)
    expect(callArgs.messages[0].role).toBe('user')
  })

  it('resolves variables in prompts from state', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({
      llmClient: mockClient,
      state: { userName: 'Alice', topic: 'weather' },
    })

    await node.run(
      makeNodeData({
        systemPrompt: 'You are {{userName}}\'s assistant.',
        prompt: 'Tell me about {{topic}}',
      }),
      '',
      context,
    )

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages[0].content).toBe('You are Alice\'s assistant.')
    expect(callArgs.messages[1].content).toBe('Tell me about weather')
  })

  it('passes model and temperature to LLM client', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(
      makeNodeData({ model: 'gpt-3.5-turbo', temperature: 0.5, prompt: 'Hi' }),
      '',
      context,
    )

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.model).toBe('gpt-3.5-turbo')
    expect(callArgs.temperature).toBe(0.5)
  })

  it('appends string input to the prompt', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(makeNodeData({ prompt: 'Base prompt' }), 'Additional input', context)

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages[0].content).toContain('Base prompt')
    expect(callArgs.messages[0].content).toContain('Additional input')
  })

  it('appends input.text to the prompt when input is an object with text', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(makeNodeData({ prompt: 'Base prompt' }), { text: 'Object input' }, context)

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages[0].content).toContain('Base prompt')
    expect(callArgs.messages[0].content).toContain('Object input')
  })

  it('throws error when llmClient is missing', async () => {
    const node = new LLMNode()
    const context = makeContext()

    await expect(node.run(makeNodeData(), '', context)).rejects.toThrow(
      'LLM client is not available in execution context',
    )
  })

  it('has correct static metadata', () => {
    const node = new LLMNode()
    expect(node.label).toBe('LLM')
    expect(node.name).toBe('llmAgentflow')
    expect(node.version).toBe(1)
    expect(node.type).toBe('LLM')
    expect(node.category).toBe('agent')
    expect(node.color).toBe('#8b5cf6')
    expect(node.inputs).toHaveLength(4)
    expect(node.inputs.map((i) => i.name)).toEqual([
      'model',
      'systemPrompt',
      'prompt',
      'temperature',
    ])
  })
})
