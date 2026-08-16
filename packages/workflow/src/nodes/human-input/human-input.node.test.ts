import { describe, it, expect, vi } from 'vitest'
import { HumanInputNode } from './human-input.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(opts: Partial<{
  prompt: string
  inputType: string
  options: unknown[]
}> = {}): INodeData {
  return {
    id: 'n1',
    name: 'humanInputAgentflow',
    inputs: {
      prompt: opts.prompt ?? '',
      inputType: opts.inputType ?? 'text',
      options: opts.options ?? [],
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

describe('HumanInputNode', () => {
  it('returns user input when humanInputResolver is provided', async () => {
    const node = new HumanInputNode()
    const resolver = vi.fn().mockResolvedValue('User response')
    const context = makeContext({ humanInputResolver: resolver })

    const result = await node.run(makeNodeData({ prompt: 'Please enter your name' }), '', context)

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('Please enter your name', 'text', [])
    expect(result.output.response).toBe('User response')
    expect(result.output.text).toBe('User response')
  })

  it('throws when humanInputResolver is missing — never fabricates the human answer', async () => {
    const node = new HumanInputNode()
    const context = makeContext()

    await expect(node.run(makeNodeData({ prompt: 'Default prompt' }), '', context)).rejects.toThrow(
      /humanInputResolver/,
    )
  })

  it('resolves variables in prompt from state', async () => {
    const node = new HumanInputNode()
    const resolver = vi.fn().mockResolvedValue('ok')
    const context = makeContext({
      humanInputResolver: resolver,
      state: { userName: 'Alice' },
    })

    await node.run(makeNodeData({ prompt: 'Hello {{userName}}, please confirm' }), '', context)

    expect(resolver).toHaveBeenCalledWith('Hello Alice, please confirm', 'text', [])
  })

  it('passes inputType and options to the resolver', async () => {
    const node = new HumanInputNode()
    const resolver = vi.fn().mockResolvedValue('yes')
    const context = makeContext({ humanInputResolver: resolver })

    const options = ['yes', 'no', 'maybe']
    await node.run(
      makeNodeData({
        prompt: 'Confirm?',
        inputType: 'select',
        options,
      }),
      '',
      context,
    )

    expect(resolver).toHaveBeenCalledWith('Confirm?', 'select', options)
  })

  it('has correct static metadata', () => {
    const node = new HumanInputNode()
    expect(node.label).toBe('Human Input')
    expect(node.name).toBe('humanInputAgentflow')
    expect(node.version).toBe(1)
    expect(node.type).toBe('HumanInput')
    expect(node.category).toBe('flow')
    expect(node.color).toBe('#ec4899')
    expect(node.inputs).toHaveLength(3)
    expect(node.inputs.map((i) => i.name)).toEqual([
      'prompt',
      'inputType',
      'options',
    ])
  })
})
