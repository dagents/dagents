import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * CustomFunction node — execute a user-provided JavaScript function.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts
 * (219 lines). The function code is wrapped in `new Function` with `$input`
 * and `$flow` parameters.
 *
 * ⚠️ Security note: `new Function` is NOT a sandbox — the code runs in global
 * scope with full access to `process`, `fetch`, `require`-equivalent globals,
 * and runs synchronously on the gateway's event loop（`while(true)` 会冻住整
 * 个进程）. Only use flows you trust; a real sandbox (isolated-vm 类方案) is
 * required before exposing flow authoring to untrusted users. 同样的模型适用
 * 于 loop break condition 和 Tool 节点 handler。
 *
 * Flowise dependencies removed:
 *   - `eval` with `flow.state` / `input` → `new Function('$input', '$flow', code)`
 *   - `ICommonObject` → `IExecutionContext`
 */
export class CustomFunctionNode implements INode {
  label = 'Custom Function'
  name = 'customFunctionAgentflow'
  version = 1
  type = 'CustomFunction'
  category = 'tools'
  color = '#3b82f6'
  inputs = [
    {
      label: 'Function Code',
      name: 'functionCode',
      type: 'code' as const,
      description: 'JavaScript code. Use `$input` for input and `$flow.state` for state.',
      rows: 6,
      default: 'return { result: $input }',
    },
    {
      label: 'Function Input',
      name: 'functionInput',
      type: 'json' as const,
      description: 'Input to pass as $input',
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    // `functionCode` 是引擎侧字段名；画布元数据用 `code`。两者都读，
    // 画布保存的函数才能真正执行（此前画布配的代码静默跑成 undefined）。
    // `functionInput` 同理兼容画布的 `parameters`。
    const functionCode =
      (nodeData.inputs?.functionCode as string) ??
      (nodeData.inputs?.code as string) ??
      ''
    const functionInput = nodeData.inputs?.functionInput ?? nodeData.inputs?.parameters ?? input

    if (!functionCode.trim()) {
      throw new Error('Custom Function requires function code')
    }

    const fn = new Function('$input', '$flow', functionCode)

    const result = fn(functionInput, { state: options.state })

    // Normalize: if the function returns a non-object, wrap it in { value }
    const output = result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown>
      : { value: result }

    return {
      id: nodeData.id,
      name: this.name,
      input: { functionInput },
      output,
      state: options.state,
    }
  }
}
