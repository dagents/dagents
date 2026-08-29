import type {
  INode,
  INodeData,
  INodeOutput,
  IExecutionContext,
  IChatMessage,
  IToolSchema,
  ITokenUsage,
} from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

/**
 * Platform Agent node — references an agent configured on the platform's
 * Agents page by its id. At execution time the node fetches the agent's
 * config (instructions, model, skills) via `options.agentFetcher` and drives
 * a full tool-calling loop against the configured LLM.
 *
 * This lets users orchestrate their platform agents inside an agentflow:
 *   - the agent's `instructions` become the system prompt,
 *   - the agent's `model` becomes the LLM model,
 *   - the agent's `skills` are declared in the prompt so the model knows the
 *     agent's capabilities,
 *   - upstream node output becomes the initial user message,
 *   - tools registered in `options.toolRegistry` are exposed to the model and
 *     invoked in a loop bounded by `maxIterations` until the model produces a
 *     final answer (no further tool calls).
 *
 * When no tools are registered the loop collapses to a single LLM call,
 * preserving the previous behaviour while still consuming `skills` and
 * `maxIterations`.
 */
export class PlatformAgentNode implements INode {
  label = 'Platform Agent'
  name = 'platformAgentAgentflow'
  version = 1
  type = 'PlatformAgent'
  category = 'agent'
  color = '#8b5cf6'
  inputs = [
    {
      label: 'Agent',
      name: 'agentId',
      type: 'string' as const,
      required: true,
      description: '平台 Agent ID（UUID）',
    },
    {
      label: '任务指令',
      name: 'systemPrompt',
      type: 'string' as const,
      description:
        '节点级任务指令（这一步要做什么、产出什么）。追加在 Agent 自身 instructions 之后 —— 同一个 Agent 在不同节点可承担不同职责。',
    },
    {
      label: 'Max Iterations',
      name: 'maxIterations',
      type: 'number' as const,
      default: 10,
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const agentId = (nodeData.inputs?.agentId as string) ?? ''

    if (!agentId) {
      throw new Error('Platform Agent node requires an agentId')
    }

    if (!options.agentFetcher) {
      throw new Error('Agent fetcher is not available in execution context')
    }

    const agentConfig = await options.agentFetcher(agentId)
    if (!agentConfig) {
      throw new Error(`Platform agent "${agentId}" not found`)
    }

    const model = agentConfig.model || ''
    const baseInstructions = resolveVariables(agentConfig.instructions, options.state) as string
    // 节点级任务指令：这一步的职责，追加在 Agent 自身 instructions 之后。
    // 没有它，流程里多个节点绑同一个 Agent 时只能靠上游接龙隐式分工。
    const nodeTask = resolveVariables((nodeData.inputs?.systemPrompt as string) ?? '', options.state) as string
    const combinedInstructions = [baseInstructions, nodeTask]
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .join('\n\n')
    const systemPrompt = this.buildSystemPrompt(combinedInstructions, agentConfig.skills ?? [])

    // Extract user message from upstream input. 多上游合并时 `content` 是
    // 全部上游的拼接、`text` 只剩最后一条（Object.assign 覆盖），故优先
    // 取 content（与 llm.node 的修复一致）。
    let userMessage = ''
    if (typeof input === 'string' && input.length > 0) {
      userMessage = input
    } else if (typeof input === 'object' && input !== null) {
      const rec = input as Record<string, unknown>
      const content = typeof rec.content === 'string' ? rec.content : ''
      const text = typeof rec.text === 'string' ? rec.text : ''
      userMessage = content.length > 0 ? content : text
    }

    if (!options.llmClient) {
      throw new Error('LLM client is not available in execution context')
    }

    const maxIterationsRaw = (nodeData.inputs?.maxIterations as number) ?? 10
    const maxIterations = Number.isFinite(maxIterationsRaw) && maxIterationsRaw > 0
      ? Math.floor(maxIterationsRaw)
      : 10

    // Build the tool schema list from the registry. Only tools present in the
    // registry are exposed; an empty registry yields no tools and the loop
    // degenerates to a single LLM call.
    const toolRegistry = options.toolRegistry ?? {}
    const tools: IToolSchema[] = Object.values(toolRegistry).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const messages: IChatMessage[] = [{ role: 'system', content: systemPrompt }]
    if (userMessage.length > 0) {
      messages.push({ role: 'user', content: userMessage })
    }

    let finalText = ''
    let totalUsage: ITokenUsage | undefined
    let iterations = 0
    let lastToolCallIds: string[] = []

    // Tool-calling loop: call the LLM, execute any requested tools, feed the
    // results back, and repeat until the model replies without tool calls or
    // the iteration budget is exhausted.
    while (iterations < maxIterations) {
      iterations += 1
      const result = await options.llmClient.chat({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        signal: options.signal,
      })
      totalUsage = accumulateUsage(totalUsage, result.usage)

      const toolCalls = result.tool_calls
      if (!toolCalls || toolCalls.length === 0 || tools.length === 0) {
        // No tool calls (or no tools available) — this is the final answer.
        finalText = result.text || finalText
        lastToolCallIds = []
        break
      }

      // Record the assistant's tool-call request. The OpenAI-compatible API
      // requires the assistant message carrying tool_calls to be echoed back
      // before the tool results.
      messages.push({
        role: 'assistant',
        content: result.text ?? '',
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: tc.function,
        })),
      })

      // Execute each tool call and append the result as a tool message.
      for (const tc of toolCalls) {
        const tool = toolRegistry[tc.function.name]
        let toolResult: string
        if (!tool) {
          toolResult = `Error: tool "${tc.function.name}" is not available`
        } else {
          try {
            const args = parseToolArgs(tc.function.arguments)
            toolResult = await tool.handler(args)
          } catch (err) {
            toolResult = `Error: tool "${tc.function.name}" failed — ${String(err)}`
          }
        }
        messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id })
      }
      lastToolCallIds = toolCalls.map((tc) => tc.id)

      // Keep any non-empty text as a fallback for when the budget runs out.
      if (result.text && result.text.length > 0) {
        finalText = result.text
      }
    }

    // If we exited the loop because the iteration budget was exhausted while
    // the model still wanted tools, surface a trailing note so the trace makes
    // clear the run was truncated rather than finished.
    if (iterations >= maxIterations && lastToolCallIds.length > 0) {
      finalText =
        finalText +
        `\n\n[Platform Agent reached the maxIterations (${maxIterations}) limit while tools were still pending]`
    }

    // 空产出守卫（与 llm.node 一致）：Agent 一轮跑完没有任何正文几乎必然
    // 是异常（CLI 截断、指令与输入错位）。诚实失败优于空壳成功流向下游。
    if (finalText.trim().length === 0) {
      throw new Error(
        `Agent 节点「${agentConfig.name}」返回空内容 — 请检查 Agent 指令与上游输入`,
      )
    }

    return {
      id: nodeData.id,
      name: this.name,
      input: {
        agentId,
        agentName: agentConfig.name,
        model,
        systemPrompt,
        userMessage,
        maxIterations,
        skills: agentConfig.skills ?? [],
        toolsAvailable: tools.map((t) => t.function.name),
      },
      output: { text: finalText, content: finalText },
      usage: totalUsage,
    }
  }

  /**
   * Build the system prompt from the agent's instructions, appending the
   * agent's declared skills so the model is aware of its capabilities. Skills
   * are free-form string labels (no executable handler is implied), so they
   * are surfaced as a capability declaration rather than callable tools.
   */
  private buildSystemPrompt(instructions: string, skills: unknown[]): string {
    const skillList = Array.isArray(skills)
      ? skills.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : []
    if (skillList.length === 0) {
      return instructions
    }
    const skillsLine = `\n\nYou have the following skills: ${skillList.join(', ')}.`
    return instructions.length > 0 ? `${instructions}${skillsLine}` : skillsLine.trim()
  }
}

/** Safely parse the JSON arguments string the LLM emits for a tool call. */
function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Accumulate token usage across multiple LLM calls in the loop. */
function accumulateUsage(
  acc: ITokenUsage | undefined,
  delta: ITokenUsage | undefined,
): ITokenUsage | undefined {
  if (!delta) return acc
  if (!acc) return { ...delta }
  return {
    prompt_tokens: (acc.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0),
    completion_tokens: (acc.completion_tokens ?? 0) + (delta.completion_tokens ?? 0),
    total_tokens: (acc.total_tokens ?? 0) + (delta.total_tokens ?? 0),
  }
}
