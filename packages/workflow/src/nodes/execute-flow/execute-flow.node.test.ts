import { describe, it, expect, vi } from 'vitest'
import { ExecuteFlowNode } from './execute-flow.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(opts: Partial<{
  flowId: string
  input: Record<string, unknown>
}> = {}): INodeData {
  return {
    id: 'n1',
    name: 'executeFlowAgentflow',
    inputs: {
      flowId: opts.flowId ?? '',
      input: opts.input ?? {},
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

describe('ExecuteFlowNode', () => {
  it('executes sub-flow when flowExecutor is provided', async () => {
    const node = new ExecuteFlowNode()
    const flowExecutor = vi.fn().mockResolvedValue({ result: 'success', data: { key: 'value' } })
    const context = makeContext({ flowExecutor })

    const inputData = { userId: '123', action: 'create' }
    const result = await node.run(
      makeNodeData({ flowId: 'flow-abc', input: inputData }),
      '',
      context,
    )

    expect(flowExecutor).toHaveBeenCalledTimes(1)
    expect(flowExecutor).toHaveBeenCalledWith('flow-abc', inputData)
    expect(result.output.output).toEqual({ result: 'success', data: { key: 'value' } })
    expect(result.output.result).toEqual({ result: 'success', data: { key: 'value' } })
  })

  it('throws when flowExecutor is missing — never echoes input as subflow output', async () => {
    const node = new ExecuteFlowNode()
    const context = makeContext()

    const inputData = { foo: 'bar' }
    await expect(
      node.run(makeNodeData({ flowId: 'flow-test', input: inputData }), '', context),
    ).rejects.toThrow(/flowExecutor/)
  })

  it('resolves variables in flowId from state', async () => {
    const node = new ExecuteFlowNode()
    const flowExecutor = vi.fn().mockResolvedValue({})
    const context = makeContext({
      flowExecutor,
      state: { env: 'production' },
    })

    await node.run(
      makeNodeData({ flowId: 'flow-{{env}}-onboarding' }),
      '',
      context,
    )

    expect(flowExecutor).toHaveBeenCalledWith('flow-production-onboarding', expect.any(Object))
  })

  it('has correct static metadata', () => {
    const node = new ExecuteFlowNode()
    expect(node.label).toBe('Execute Flow')
    expect(node.name).toBe('executeFlowAgentflow')
    expect(node.version).toBe(1)
    expect(node.type).toBe('ExecuteFlow')
    expect(node.category).toBe('flow')
    expect(node.color).toBe('#ec4899')
    expect(node.inputs).toHaveLength(2)
    expect(node.inputs.map((i) => i.name)).toEqual([
      'flowId',
      'input',
    ])
  })
})
