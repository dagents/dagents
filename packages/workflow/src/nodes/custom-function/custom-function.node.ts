import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import type { ControlledExecResult } from '../../types/execution.js'
import { runUserCode } from './user-code-exec.js'
import { parsePermissionValue, PERMISSION_FIELDS } from '../../utils/flow-permissions.js'
import { NodeRejectedError } from '../../engine/errors.js'

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
 * 前置条件，见 docs/workflow-engine.md 现状与限制。
 * （2026-09-17 勘误：旧注释称 loop break condition / Tool 节点 handler
 * 仍是同步 new Function —— 两类节点已随 D8 精简删除，仓内唯一用户代码
 * 求值点就是本文件的 worker 路径。）
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
    {
      label: '命令白名单',
      name: 'allowedCommands',
      type: 'json' as const,
      rows: 3,
      description:
        'JSON 字符串数组（如 ["git","rg"]）——声明后代码内可用 $exec(cmd, args) 执行白名单命令；留空 = $exec 不可用',
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    // `functionCode` 是引擎侧字段名；画布元数据用 `code`。两者都读，
    // 画布保存的函数才能真正执行（此前画布配的代码静默跑成 undefined）。
    // `functionInput` 同理兼容画布的 `parameters`。
    const functionCode =
      (nodeData.inputs?.functionCode as string) ?? (nodeData.inputs?.code as string) ?? ''
    const functionInput = nodeData.inputs?.functionInput ?? nodeData.inputs?.parameters ?? input

    if (!functionCode.trim()) {
      throw new Error('Custom Function requires function code')
    }

    // R4 命令白名单（白名单持有方 = 节点/engine——来自 nodeData，绝不由
    // worker 消息携带）：invalid → fail-closed 全拒（拓扑校验/保存门之外
    // 的运行时不变量，改 JSON 绕不过）；declared → 通道 armed；absent →
    // 通道不存在（$exec undefined，行为与现状零命令能力一致）。
    const commandPerm = parsePermissionValue(
      nodeData.inputs?.[PERMISSION_FIELDS.command],
      PERMISSION_FIELDS.command,
    )
    if (commandPerm.kind === 'invalid') {
      throw new NodeRejectedError(
        `节点被拒绝：customFunction 节点 ${nodeData.id}：allowedCommands 声明非法（${commandPerm.reason}）` +
          `——修复格式；修复前 $exec 全部被拒`,
      )
    }

    // FR-11（PRD）：$inputText = $input 的正文解包（content ?? text ?? JSON）。
    // 多数上游节点输出是对象 —— 用户函数里 String($input) 得到
    // "[object Object]"（实测踩坑），逐个解构又啰嗦。正文变量一步到位。
    const inputText =
      typeof functionInput === 'string'
        ? functionInput
        : typeof functionInput === 'object' && functionInput !== null
          ? (((functionInput as Record<string, unknown>).content as string) ??
            ((functionInput as Record<string, unknown>).text as string) ??
            JSON.stringify(functionInput))
          : String(functionInput ?? '')

    // worker 执行（超时强杀 + 取消贯穿；详见 user-code-exec.ts 头注释）。
    // 每次 $exec 起止发 tool/tool_result 活动行（契约「采集层保全文」：
    // label=命令名、detail=参数/输出全文）——终端/轨迹/摘要三视图零改动
    // 即可见每条命令。
    const result = await runUserCode(functionCode, functionInput, inputText, options.state, {
      signal: options.signal,
      ...(commandPerm.kind === 'declared'
        ? { allowedCommands: commandPerm.values, execRunner: options.execRunner }
        : {}),
      onExecActivity: (event) => {
        if (event.phase === 'start') {
          options.onNodeDelta?.({
            type: 'activity',
            kind: 'tool',
            label: event.command,
            detail: JSON.stringify(event.args),
          })
          return
        }
        options.onNodeDelta?.({
          type: 'activity',
          kind: 'tool_result',
          label: event.command,
          detail: formatExecResult(event.result, event.error),
        })
      },
    }).catch((err: unknown) => {
      // 拒绝档词汇统一（集成裁决 2026-10-08，R9d 对照表）：worker 侧错误
      // 跨线程回传后是普通 Error——按「节点被拒绝：」首词恢复 NodeRejectedError
      // 类型（executor 管道据此落 span 'rejected'，不与文案双写）；
      // 通道未声明时用户代码调用 $exec 抛 TypeError（$exec 是 undefined）——
      // 翻译成结构化指引（AC-R4-2），不给用户看裸 JS 栈。
      const message = err instanceof Error ? err.message : String(err)
      if (/\$exec is not a function/.test(message)) {
        throw new NodeRejectedError(
          `节点被拒绝：customFunction 节点 ${nodeData.id}：$exec 不可用——本节点未声明 allowedCommands；` +
            `在节点配置「命令白名单」声明后方可调用命令`,
        )
      }
      if (message.includes('节点被拒绝：')) {
        // worker 回传形态是 err.stack 再裹一层「custom function threw: 」前缀
        // （user-code-exec worker 侧 String(err.stack)），故用包含匹配而非
        // startsWith；误判面 = 用户代码自己抛出该字面（仅影响 span 状态档
        // 词，无权限语义），可接受。
        throw new NodeRejectedError(message.slice(Math.max(0, message.indexOf('节点被拒绝：'))), {
          cause: err,
        })
      }
      throw err
    })

    // Normalize: if the function returns a non-object, wrap it in { value }
    const output =
      result !== null && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
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

/** $exec tool_result 活动行 detail（采集层保全文：stdout/stderr + 退出码）。 */
function formatExecResult(result?: ControlledExecResult, error?: string): string {
  if (error) return `error: ${error}`
  if (!result) return ''
  return [
    `exit: ${result.code ?? 'null'}`,
    result.stdout,
    result.stderr ? `stderr: ${result.stderr}` : '',
    result.truncated ? '（输出超 32KB 已截断：保头 60% + 保尾 40%）' : '',
  ]
    .filter(Boolean)
    .join('\n')
}
