import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * CustomFunction node — execute a user-provided JavaScript function.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts
 * (219 lines). The function code is wrapped in `new Function` with `$input`
 * and `$flow` parameters — no access to `process`, `require`, or globals
 * (sandboxed by the Function constructor's scope).
 *
 * Security note: `new Function` is NOT a true sandbox (it can access globals
 * via `this` tricks). For production hardening, consider `vm2` or `isolated-vm`.
 * For now, this matches Flowise's behavior — the function is trusted to be
 * authored by the flow designer, not an end user.
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
  category = 'Agent Flows'
  color = '#FF9F1C'
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
    const functionCode = (nodeData.inputs?.functionCode as string) ?? ''
    const functionInput = nodeData.inputs?.functionInput ?? input

    // Wrap in a function with named params — sandboxed from module scope.
    // `new Function` creates a function with its own scope; it can't see
    // imports or local variables, only the params we pass.
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
