import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { runUserCode } from './user-code-exec.js'

/**
 * CustomFunction node — execute a user-provided JavaScript function.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts
 * (219 lines). The function code is wrapped in `new Function` with `$input`
 * and `$flow` parameters.
 *
 * 执行硬化（2026-09-06）：用户代码改在 worker_threads 执行（user-code-exec.ts）
 * —— 超时强杀（默认 5s，CUSTOM_FN_TIMEOUT_MS）、AbortSignal 贯穿、危险全局
 * （require/process/globalThis/fetch/Worker）以形参 shadow 成 undefined。
 * 这是**隔离不是沙箱**：刻意逃逸（constructor 链）拦不住；死循环冻住网关
 * 事件循环的旧问题已消除。真沙箱（isolated-vm/子进程隔离）是多用户化的
 * 前置条件，见 docs/workflow-engine.md 现状与限制。loop break condition 与
 * Tool 节点 handler 仍是同步 new Function（待同样处理）。
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

    // FR-11（PRD）：$inputText = $input 的正文解包（content ?? text ?? JSON）。
    // 多数上游节点输出是对象 —— 用户函数里 String($input) 得到
    // "[object Object]"（实测踩坑），逐个解构又啰嗦。正文变量一步到位。
    const inputText =
      typeof functionInput === 'string'
        ? functionInput
        : typeof functionInput === 'object' && functionInput !== null
          ? ((functionInput as Record<string, unknown>).content as string) ??
            ((functionInput as Record<string, unknown>).text as string) ??
            JSON.stringify(functionInput)
          : String(functionInput ?? '')

    // worker 执行（超时强杀 + 取消贯穿；详见 user-code-exec.ts 头注释）
    const result = await runUserCode(functionCode, functionInput, inputText, options.state, {
      signal: options.signal,
    })

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
