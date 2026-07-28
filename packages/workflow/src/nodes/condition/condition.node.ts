import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * Condition node — evaluate comparison rules and return which branch matches.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Condition/Condition.ts
 * (371 lines). In Plan A, this node only evaluates conditions and returns
 * `matched: 'true' | 'false'`. The executor's branch routing (skipping nodes
 * based on the match) is in Plan B.
 *
 * Supported operators: ===, !==, >, <, >=, <=, contains, startsWith, endsWith.
 * Multiple conditions use OR logic (any match → 'true').
 */

interface ConditionRule {
  comparisonOperator: string
  valueToCompare: string
  valueToCompareAgainst: string
  trueBranch?: unknown[]
  falseBranch?: unknown[]
}

export class ConditionNode implements INode {
  label = 'Condition'
  name = 'conditionAgentflow'
  version = 1
  type = 'Condition'
  category = 'logic'
  color = '#f59e0b'
  inputs = [
    {
      label: 'Conditions',
      name: 'conditions',
      type: 'json' as const,
      description: 'Array of condition rules (OR logic)',
      rows: 6,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const conditions = (nodeData.inputs?.conditions as ConditionRule[]) ?? []

    // Put input into state so resolveVariables can find it as {{input}}
    const stateWithInput = { ...options.state, input: typeof input === 'string' ? input : JSON.stringify(input) }

    let matched = false
    for (const rule of conditions) {
      const left = String(resolveVariables(rule.valueToCompare, stateWithInput))
      const right = String(resolveVariables(rule.valueToCompareAgainst, stateWithInput))

      if (evaluateOperator(left, rule.comparisonOperator, right)) {
        matched = true
        break
      }
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { conditions },
      output: { matched: matched ? 'true' : 'false' },
      state: options.state,
    }
  }
}

function evaluateOperator(left: string, operator: string, right: string): boolean {
  switch (operator) {
    case '===':
      return left === right
    case '!==':
      return left !== right
    case '>':
      return Number(left) > Number(right)
    case '<':
      return Number(left) < Number(right)
    case '>=':
      return Number(left) >= Number(right)
    case '<=':
      return Number(left) <= Number(right)
    case 'contains':
      return left.includes(right)
    case 'startsWith':
      return left.startsWith(right)
    case 'endsWith':
      return left.endsWith(right)
    default:
      return false
  }
}
