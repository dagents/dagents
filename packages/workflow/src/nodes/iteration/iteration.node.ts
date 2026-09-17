import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Iteration node — parse an array input for the executor to iterate over.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Iteration/Iteration.ts.
 * The node parses + validates the array; the DagExecutor (see `planLoopBody` /
 * `runLoopBody`) detects the controller output and executes the sub-DAG
 * reachable from the node's `iteration` output anchor once per item, seeding
 * each iteration with the item (available downstream as `iterationItem` /
 `iterationIndex` in runtime state and as the incoming input string).
 *
 * Flowise dependencies removed:
 *   - `parseJsonBody` from `../../../src/utils` → inline `safeParseJson`
 *   - `ICommonObject` → `IExecutionContext`
 */
export class IterationNode implements INode {
  label = 'Iteration'
  name = 'iterationAgentflow'
  version = 1
  type = 'Iteration'
  category = 'flow'
  color = '#ec4899'
  /** 与 executor 的 runIterationBody 上限保持同值（节点侧先抛 → span 带错）。 */
  static readonly MAX_ITEMS = 100
  inputs = [
    {
      label: 'Items',
      name: 'items',
      type: 'string' as const,
      description: 'The JSON array to iterate over (one body execution per item)',
      acceptVariable: true,
      rows: 4,
    },
    {
      label: 'Array Input',
      name: 'iterationInput',
      type: 'string' as const,
      description: 'Legacy alias for Items',
      acceptVariable: true,
      rows: 4,
      hide: true,
    },
  ]

  async run(nodeData: INodeData, _input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const iterationInput = nodeData.inputs?.items ?? nodeData.inputs?.iterationInput

    const safeParseJson = (str: string): unknown => {
      try {
        return JSON.parse(str)
      } catch {
        try {
          // Try parsing after cleaning redundant backslashes
          return JSON.parse(str.replace(/\\(["'[\]{}])/g, '$1'))
        } catch {
          // Both parses failed — return the original string so the array
          // check below throws a clean "Invalid input array" error.
          return str
        }
      }
    }

    const iterationInputArray =
      typeof iterationInput === 'string' && iterationInput !== ''
        ? safeParseJson(iterationInput)
        : iterationInput

    if (!iterationInputArray || !Array.isArray(iterationInputArray)) {
      throw new Error('Invalid input array')
    }

    // 超上限在这里抛（而非 executor 截断）：节点自身 failed → span 带
    // 错误信息 → runs 失败摘要可见；静默跑前 100 项是数据丢失伪装成
    // 成功（2026-09-17 评审修订，executor 侧另有同值防御）。
    if (iterationInputArray.length > IterationNode.MAX_ITEMS) {
      throw new Error(
        `Iteration 节点的列表有 ${iterationInputArray.length} 项，超过上限 ` +
          `${IterationNode.MAX_ITEMS}（拒绝静默截断 —— 请在上游缩小列表或分批运行）`,
      )
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { iterationInput: iterationInputArray },
      output: { iterationInput: iterationInputArray },
      state: options.state,
    }
  }
}
