import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'

/**
 * Tool node — define and execute a custom tool inline.
 *
 * Migrated from vendor/flowise/packages/components/nodes/agentflow/Tool/Tool.ts.
 * The node takes a tool name, description, JSON-Schema parameters, and a
 * JavaScript handler. When the flow reaches it:
 *
 *   1. The handler runs once (`new Function('$input', '$flow', code)` — the
 *      same sandboxing approach as CustomFunctionNode: module scope is
 *      inaccessible, the code is trusted to be authored by the flow designer)
 *      and its return value becomes the node output.
 *   2. The tool is registered into the run's tool registry overlay
 *      (`options.toolRegistry`), so downstream Agent / Platform Agent nodes
 *      can call it in their tool-calling loop with the declared schema.
 *
 * Legacy graphs that only configured `toolName` + `toolInput` still work: the
 * upstream input (or `toolInput`) is passed through as `$input`.
 */
export class ToolNode implements INode {
  label = 'Tool'
  name = 'toolAgentflow'
  version = 1
  type = 'Tool'
  category = 'tools'
  color = '#3b82f6'
  inputs = [
    {
      label: 'Tool Name',
      name: 'toolName',
      type: 'string' as const,
      description: 'The name of the tool to invoke',
      required: true,
      acceptVariable: true,
    },
    {
      label: 'Tool Description',
      name: 'toolDescription',
      type: 'string' as const,
      description: 'What the tool does — shown to LLM agents deciding whether to call it',
    },
    {
      label: 'Parameters',
      name: 'parameters',
      type: 'json' as const,
      description: 'JSON Schema describing the tool parameters',
      rows: 4,
    },
    {
      label: 'Handler',
      name: 'handler',
      type: 'code' as const,
      description: 'JavaScript code. Use `$input` for the tool input and `$flow.state` for state.',
      rows: 8,
    },
    {
      label: 'Tool Input',
      name: 'toolInput',
      type: 'json' as const,
      description: 'Input to pass as $input when executing the node in the flow',
      acceptVariable: true,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const toolName = nodeData.inputs?.toolName as string
    if (!toolName) {
      throw new Error('Tool node requires a tool name')
    }

    const toolDescription = (nodeData.inputs?.toolDescription as string) ?? ''
    const handlerCode = (nodeData.inputs?.handler as string) ?? ''
    const parameters = (nodeData.inputs?.parameters as Record<string, unknown>) ?? {}
    const toolInput = nodeData.inputs?.toolInput ?? input

    // 1. Register the tool for downstream Agent / Platform Agent tool-calling.
    //    The registry is a per-run overlay created by the executor, so writes
    //    don't leak between runs.
    if (options.toolRegistry && handlerCode.trim() !== '') {
      options.toolRegistry[toolName] = {
        name: toolName,
        description: toolDescription || `Custom tool "${toolName}"`,
        parameters: isPlainObject(parameters) ? parameters : { type: 'object', properties: {} },
        handler: async (args: Record<string, unknown>) => {
          const fn = new Function('$input', '$flow', handlerCode)
          const result = fn(args, { state: options.state })
          return typeof result === 'string' ? result : JSON.stringify(result ?? null)
        },
      }
    }

    // 2. Execute the handler once in the flow, so the node's output is the
    //    tool result (upstream nodes can consume it directly).
    let output: Record<string, unknown>
    if (handlerCode.trim() !== '') {
      const fn = new Function('$input', '$flow', handlerCode)
      const result = await fn(toolInput, { state: options.state })
      output = {
        toolName,
        result: result !== null && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { value: result },
        registered: true,
      }
    } else {
      output = {
        toolName,
        result: this.toRecord(toolInput),
        registered: options.toolRegistry !== undefined,
        message: 'Tool node has no handler — passed input through and registered the name only',
      }
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: { toolName, toolInput },
      output,
      state: options.state,
    }
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value == null) return {}
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return { value }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
