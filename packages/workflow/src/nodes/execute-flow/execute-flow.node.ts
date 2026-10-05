import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * ExecuteFlow 节点 —— 子流程一等公民（2026-10-04 多人格优化轮复活）。
 *
 * D8（2026-09-05）精简时随旧引擎一起删除；本轮以引擎 DB-free 纪律复活：
 * 节点只持有「目标 flowId + 输入模板」，实际加载与执行由宿主注入的
 * `flowExecutor`（IExecutionContext seam）完成——引擎不碰 flows 表。
 *
 * 宿主（gateway）的执行器复用父 run 的同一套 clients（LLM/工具/人机输入），
 * 嵌套深度、防自引用由宿主侧守卫。输出 = 子流程的 finalOutput（content
 * 承接其正文约定），下游模板 `{{id.content}}` / `{{id.output.<field>}}` 取用。
 *
 * 无 flowExecutor（宿主未装配，如单测）→ 诚实报错，不静默空转。
 */
export class ExecuteFlowNode implements INode {
  label = 'ExecuteFlow'
  name = 'executeFlowAgentflow'
  version = 1
  type = 'EXECUTE_FLOW'
  category = 'flow'
  color = '#ec4899'
  inputs = [
    {
      label: 'Flow ID',
      name: 'targetFlowId',
      type: 'string' as const,
      required: true,
      default: '',
      description:
        '目标流程的 ID（画布「另存为模板/复制链接」可查；从 Flows 列表进入目标流程，URL 里 /workflows/<id>/canvas 的 id）',
    },
    {
      label: 'Input',
      name: 'input',
      type: 'code' as const,
      rows: 3,
      default: '',
      description: '传给子流程的输入（支持模板变量）；留空则透传上游输出',
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const targetRaw = (nodeData.inputs?.targetFlowId as string) ?? ''
    // 模板变量解析（flowId 可能经变量传入）
    const targetFlowId = String(resolveVariables(targetRaw, options.state) ?? targetRaw).trim()
    if (!/^[0-9a-fA-F-]{8,64}$/.test(targetFlowId)) {
      throw new Error(
        'ExecuteFlow 节点缺少有效的目标 Flow ID——请在节点配置里填 targetFlowId（目标流程画布 URL 中的 id）',
      )
    }

    const inputTemplate = (nodeData.inputs?.input as string) ?? ''
    const resolvedInput =
      inputTemplate.trim().length > 0 ? resolveVariables(inputTemplate, options.state) : input

    if (!options.flowExecutor) {
      throw new Error('宿主未装配子流程执行器（flowExecutor）——ExecuteFlow 节点在当前环境不可用')
    }

    const startedAt = new Date().toISOString()
    const sub = await options.flowExecutor(targetFlowId, resolvedInput, { signal: options.signal })
    if (sub.status === 'failed' || sub.status === 'cancelled' || sub.status === 'budget_exceeded') {
      throw new Error(
        `子流程执行失败（${sub.status}）：${typeof sub.output?.content === 'string' ? sub.output.content.slice(0, 300) : '无输出详情'}`,
      )
    }

    const content =
      typeof sub.output.content === 'string'
        ? sub.output.content
        : sub.output != null && Object.keys(sub.output).length > 0
          ? JSON.stringify(sub.output)
          : ''

    return {
      id: nodeData.id,
      name: this.name,
      input: { targetFlowId, input: resolvedInput },
      output: {
        text: content,
        content,
        subflowStatus: sub.status,
        output: sub.output,
        startedAt,
      },
    }
  }
}
