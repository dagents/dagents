import { describe, it, expect, vi } from 'vitest'
import { AgentNode } from './agent.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeMockLlmClient(text: string) {
  return {
    chat: vi.fn().mockResolvedValue({ text }),
  }
}

function makeNodeData(opts: Partial<{
  model: string
  systemPrompt: string
  tools: string[]
  maxIterations: number
}> = {}): INodeData {
  return {
    id: 'n1',
    name: 'agentAgentflow',
    inputs: {
      model: opts.model ?? 'gpt-4',
      systemPrompt: opts.systemPrompt ?? 'You are a helpful assistant.',
      tools: opts.tools ?? [],
      maxIterations: opts.maxIterations ?? 10,
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

describe('AgentNode', () => {
  it('performs basic LLM call and returns text', async () => {
    const node = new AgentNode()
    const mockClient = makeMockLlmClient('Agent response')
    const context = makeContext({ llmClient: mockClient })

    const result = await node.run(makeNodeData(), 'Hello agent', context)

    expect(mockClient.chat).toHaveBeenCalledTimes(1)
    expect(result.output.text).toBe('Agent response')
    expect(result.output.content).toBe('Agent response')
    expect(result.id).toBe('n1')
    expect(result.name).toBe('agentAgentflow')
  })

  it('resolves variables in system prompt from state', async () => {
    const node = new AgentNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({
      llmClient: mockClient,
      state: { userName: 'Bob', role: 'developer' },
    })

    await node.run(
      makeNodeData({ systemPrompt: 'You are {{userName}}, a {{role}}.' }),
      'Hi',
      context,
    )

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe('You are Bob, a developer.')
  })

  it('includes user message in messages when input is string', async () => {
    const node = new AgentNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(makeNodeData(), 'Hello there', context)

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages).toHaveLength(2)
    expect(callArgs.messages[1].role).toBe('user')
    expect(callArgs.messages[1].content).toBe('Hello there')
  })

  it('includes user message when input is object with text', async () => {
    const node = new AgentNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(makeNodeData(), { text: 'Object input' }, context)

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages).toHaveLength(2)
    expect(callArgs.messages[1].content).toBe('Object input')
  })

  it('uses default system prompt when not provided', async () => {
    const node = new AgentNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(
      { id: 'n1', name: 'agentAgentflow', inputs: { model: 'gpt-4' } },
      'Hi',
      context,
    )

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages[0].content).toBe('You are a helpful assistant.')
  })

  it('throws error when llmClient is missing', async () => {
    const node = new AgentNode()
    const context = makeContext()

    await expect(node.run(makeNodeData(), 'Hi', context)).rejects.toThrow(
      'LLM client is not available in execution context',
    )
  })

  it('has correct static metadata', () => {
    const node = new AgentNode()
    expect(node.label).toBe('Agent')
    expect(node.name).toBe('agentAgentflow')
    expect(node.version).toBe(1)
    expect(node.type).toBe('Agent')
    expect(node.category).toBe('agent')
    expect(node.color).toBe('#8b5cf6')
    expect(node.inputs).toHaveLength(4)
    expect(node.inputs.map((i) => i.name)).toEqual([
      'model',
      'systemPrompt',
      'tools',
      'maxIterations',
    ])
  })
})
