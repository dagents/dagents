import { describe, it, expect, vi } from 'vitest'
import { ConditionAgentNode } from './condition-agent.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeMockLlmClient(text: string) {
  return {
    chat: vi.fn().mockResolvedValue({ text }),
  }
}

function makeNodeData(opts: Partial<{
  model: string
  systemPrompt: string
  scenarios: unknown[]
}> = {}): INodeData {
  return {
    id: 'n1',
    name: 'conditionAgentAgentflow',
    inputs: {
      model: opts.model ?? 'gpt-4',
      systemPrompt: opts.systemPrompt ?? '',
      scenarios: opts.scenarios ?? [],
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

describe('ConditionAgentNode', () => {
  it('selects a scenario using LLM when llmClient is available', async () => {
    const node = new ConditionAgentNode()
    const mockClient = makeMockLlmClient('billing')
    const context = makeContext({ llmClient: mockClient })

    const scenarios = [
      { name: 'billing', description: 'Billing and payment issues' },
      { name: 'support', description: 'General support questions' },
      { name: 'sales', description: 'Sales and product inquiries' },
    ]

    const result = await node.run(makeNodeData({ scenarios }), 'I want to pay my bill', context)

    expect(mockClient.chat).toHaveBeenCalledTimes(1)
    expect(result.output.selected).toBe('billing')
    expect(result.output.result).toBe('billing')
    expect(result.output.reason).toContain('LLM selected scenario')
  })

  it('uses first scenario as default when llmClient is missing', async () => {
    const node = new ConditionAgentNode()
    const context = makeContext()

    const scenarios = [
      { name: 'default', description: 'Default scenario' },
      { name: 'other', description: 'Other scenario' },
    ]

    const result = await node.run(makeNodeData({ scenarios }), 'some input', context)

    expect(result.output.selected).toBe('default')
    expect(result.output.result).toBe('default')
    expect(result.output.reason).toContain('LLM client not available')
  })

  it('handles empty scenarios list', async () => {
    const node = new ConditionAgentNode()
    const mockClient = makeMockLlmClient('anything')
    const context = makeContext({ llmClient: mockClient })

    const result = await node.run(makeNodeData({ scenarios: [] }), 'some input', context)

    expect(mockClient.chat).not.toHaveBeenCalled()
    expect(result.output.selected).toBe('')
    expect(result.output.result).toBe('')
    expect(result.output.reason).toBe('No scenarios provided')
  })

  it('falls back to first scenario when LLM response does not match any scenario', async () => {
    const node = new ConditionAgentNode()
    const mockClient = makeMockLlmClient('unknown_scenario')
    const context = makeContext({ llmClient: mockClient })

    const scenarios = [
      { name: 'first', description: 'First scenario' },
      { name: 'second', description: 'Second scenario' },
    ]

    const result = await node.run(makeNodeData({ scenarios }), 'some input', context)

    expect(result.output.selected).toBe('first')
    expect(result.output.result).toBe('first')
    expect(result.output.reason).toContain('did not match any scenario')
  })

  it('resolves variables in system prompt from state', async () => {
    const node = new ConditionAgentNode()
    const mockClient = makeMockLlmClient('billing')
    const context = makeContext({
      llmClient: mockClient,
      state: { userName: 'Alice' },
    })

    const scenarios = [{ name: 'billing', description: 'Billing' }]

    await node.run(
      makeNodeData({
        systemPrompt: 'You are {{userName}}\'s assistant.',
        scenarios,
      }),
      'test input',
      context,
    )

    const callArgs = mockClient.chat.mock.calls[0][0]
    expect(callArgs.messages[0].content).toBe('You are Alice\'s assistant.')
  })

  it('has correct static metadata', () => {
    const node = new ConditionAgentNode()
    expect(node.label).toBe('Condition Agent')
    expect(node.name).toBe('conditionAgentAgentflow')
    expect(node.version).toBe(1)
    expect(node.type).toBe('ConditionAgent')
    expect(node.category).toBe('logic')
    expect(node.color).toBe('#f59e0b')
    expect(node.inputs).toHaveLength(3)
    expect(node.inputs.map((i) => i.name)).toEqual([
      'model',
      'systemPrompt',
      'scenarios',
    ])
  })
})
