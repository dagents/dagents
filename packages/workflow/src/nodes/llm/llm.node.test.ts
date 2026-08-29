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

  it('prefers the concatenated content over the last-edge text in merged multi-upstream input', async () => {
    // mergeInputs 的多上游形状：content = 全部上游拼接；text 被
    // Object.assign 用最后一条边覆盖只剩一份。只取 text 会丢 N-1 份上游
    // 产出（「产品发现（并行）」汇总节点丢 3/4 简报的回归）。
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })
    const mergedInput = {
      text: 'brief-from-last-edge',
      content: 'brief-A\nbrief-B\nbrief-C',
    }

    await node.run(makeNodeData({ prompt: 'Merge these' }), mergedInput, context)

    const callArgs = mockClient.chat.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain('brief-A')
    expect(userContent).toContain('brief-B')
    expect(userContent).toContain('brief-C')
    // 拼接后的 content 是唯一正文来源，不再混入被覆盖的 text
    expect(userContent).not.toContain('brief-from-last-edge')
  })

  it('falls back to input.text when merged content is absent or empty', async () => {
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('response')
    const context = makeContext({ llmClient: mockClient })

    await node.run(makeNodeData({ prompt: 'Base' }), { text: 'only-text' }, context)
    await node.run(makeNodeData({ prompt: 'Base' }), { text: 'kept', content: '' }, context)

    expect(mockClient.chat.mock.calls[0][0].messages[0].content).toContain('only-text')
    expect(mockClient.chat.mock.calls[1][0].messages[0].content).toContain('kept')
  })

  it('throws on an empty LLM response instead of marking the node done', async () => {
    // 空产出守卫：CLI/HTTP 返回空文本时诚实失败（此前 180s 后
    // content="" 且 status=done 的空成功会静默流向下游）。
    const node = new LLMNode()
    const mockClient = makeMockLlmClient('   ')
    const context = makeContext({ llmClient: mockClient })

    await expect(node.run(makeNodeData({ prompt: 'Hi' }), '', context)).rejects.toThrow(
      /返回空内容/,
    )
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

describe('LLMNode (streaming)', () => {
  function makeStreamingClient(deltas: string[]) {
    return {
      chat: vi.fn(),
      chatStream: vi.fn().mockImplementation(async function* () {
        for (const d of deltas) {
          yield { delta: d }
        }
        yield { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }
      }),
    }
  }

  function makeStreamingContext(client: ReturnType<typeof makeStreamingClient>) {
    const streamer = {
      streamTokenEvent: vi.fn(),
      streamEndEvent: vi.fn(),
      streamErrorEvent: vi.fn(),
    }
    return {
      context: {
        chatId: 'c1',
        runId: 'r1',
        state: {},
        isLastNode: true,
        sseStreamer: streamer,
        llmClient: client,
      } as unknown as IExecutionContext,
      streamer,
    }
  }

  it('streams tokens via sseStreamer when last node + chatStream available', async () => {
    const node = new LLMNode()
    const client = makeStreamingClient(['Hello', ' ', 'world'])
    const { context, streamer } = makeStreamingContext(client)

    const result = await node.run(makeNodeData({ prompt: 'Hi' }), '', context)

    expect(client.chat).not.toHaveBeenCalled()
    expect(client.chatStream).toHaveBeenCalledTimes(1)
    expect(streamer.streamTokenEvent).toHaveBeenCalledTimes(3)
    expect(streamer.streamTokenEvent).toHaveBeenNthCalledWith(1, 'c1', 'Hello')
    expect(streamer.streamTokenEvent).toHaveBeenNthCalledWith(3, 'c1', 'world')
    expect(result.output.text).toBe('Hello world')
    expect(result.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
  })

  it('falls back to chat when not the last node', async () => {
    const node = new LLMNode()
    const client = makeStreamingClient(['ignored'])
    const { context } = makeStreamingContext(client)
    context.isLastNode = false
    client.chat = vi.fn().mockResolvedValue({ text: 'non-streamed' })

    const result = await node.run(makeNodeData({ prompt: 'Hi' }), '', context)
    expect(client.chatStream).not.toHaveBeenCalled()
    expect(result.output.text).toBe('non-streamed')
  })

  it('falls back to chat when the client has no chatStream', async () => {
    const node = new LLMNode()
    const client = { chat: vi.fn().mockResolvedValue({ text: 'plain' }) }
    const { context } = makeStreamingContext(client as never)

    const result = await node.run(makeNodeData({ prompt: 'Hi' }), '', context)
    expect(result.output.text).toBe('plain')
  })

  it('throws on an empty streamed response instead of returning an empty success', async () => {
    const node = new LLMNode()
    const client = makeStreamingClient([])
    const { context } = makeStreamingContext(client)

    await expect(node.run(makeNodeData({ prompt: 'Hi' }), '', context)).rejects.toThrow(
      /返回空内容/,
    )
  })
})
