import { describe, it, expect } from 'vitest'
import { ConditionNode } from './condition.node.js'
import type { INodeData, IExecutionContext } from '../../types/index.js'

function makeNodeData(conditions: unknown): INodeData {
  return {
    id: 'n1',
    name: 'conditionAgentflow',
    inputs: { conditions },
  }
}

function makeContext(): IExecutionContext {
  return { chatId: 'c1', runId: 'r1', state: {}, isLastNode: false }
}

describe('ConditionNode', () => {
  it('evaluates a simple equality condition (true)', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'hello', trueBranch: [], falseBranch: [] },
    ]
    const result = await node.run(makeNodeData(conditions), 'hello', makeContext())
    expect(result.output.matched).toBe('true')
  })

  it('evaluates a simple equality condition (false)', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'hello', trueBranch: [], falseBranch: [] },
    ]
    const result = await node.run(makeNodeData(conditions), 'world', makeContext())
    expect(result.output.matched).toBe('false')
  })

  it('evaluates greater-than', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '>', valueToCompare: '{{input}}', valueToCompareAgainst: '10', trueBranch: [], falseBranch: [] },
    ]
    const result = await node.run(makeNodeData(conditions), '15', makeContext())
    expect(result.output.matched).toBe('true')
  })

  it('evaluates multiple conditions (OR logic)', async () => {
    const node = new ConditionNode()
    const conditions = [
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'a', trueBranch: [], falseBranch: [] },
      { comparisonOperator: '===', valueToCompare: '{{input}}', valueToCompareAgainst: 'b', trueBranch: [], falseBranch: [] },
    ]
    const result1 = await node.run(makeNodeData(conditions), 'a', makeContext())
    expect(result1.output.matched).toBe('true')
    const result2 = await node.run(makeNodeData(conditions), 'b', makeContext())
    expect(result2.output.matched).toBe('true')
    const result3 = await node.run(makeNodeData(conditions), 'c', makeContext())
    expect(result3.output.matched).toBe('false')
  })

  it('has correct static metadata', () => {
    const node = new ConditionNode()
    expect(node.name).toBe('conditionAgentflow')
    expect(node.type).toBe('Condition')
  })
})
