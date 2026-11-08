import type {
  INode,
  INodeData,
  INodeOutput,
  IExecutionContext,
  IChatMessage,
  IToolSchema,
  ITokenUsage,
  IAgentTool,
  IStreamDelta,
} from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'
import {
  extractJsonFromText,
  validateAgainstSchema,
  type SchemaIssue,
} from '../../utils/json-schema-lite.js'
import { NodeRejectedError } from '../../engine/errors.js'

/**
 * R5 三值裁决预算上限（PRD 定稿值，禁止实现层私调——见 requirements.md R5
 * 需求 3）：原始执行 + 1 轮修复回喂 + 1 轮 NUDGE 追问。不设 env 旋钮——
 * env 即私调面；产品要调尺度必须改 PRD 定稿值本身。
 */
export const VERDICT_MAX_INTERACTIONS = 3

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
 *
 * 三值裁决（2026-10-07 R5，docs/zcode-borrow/design-verdict.md）：声明了
 * outputSchema 时，工具循环外再包一层裁决循环——accept（合规收下，输出带
 * `json` 字段）/ violations（回喂 path/期望/实际 修复一次）/ no-deliverable
 * （NUDGE 追问一次），预算 VERDICT_MAX_INTERACTIONS 次交互，耗尽即诚实失败。
 * 未声明 outputSchema = 现状路径原样（零行为变更）。
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
    {
      label: 'Output Schema (JSON)',
      name: 'outputSchema',
      type: 'json' as const,
      rows: 6,
      default: '',
      description:
        '可选 JSON Schema：要求 Agent 最终交付符合该结构的 JSON。三值裁决——合规收下（输出带 json 字段，模板 {{id.json}}）/ 违规回喂修复（path/期望/实际）/ 未交付追问一次；预算 3 次交互内仍不合规则节点诚实失败',
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
    const nodeTask = resolveVariables(
      (nodeData.inputs?.systemPrompt as string) ?? '',
      options.state,
    ) as string
    const combinedInstructions = [
      // flow 级上下文（P2a）：宿主预算预裁后的 context_md——最特定的
      // 注入块，摆在人格 instructions 之前（dsh 取舍序：特定 > 宽泛）。
      options.flowContext?.trim() ? `【流程上下文】\n${options.flowContext.trim()}` : '',
      baseInstructions,
      nodeTask,
    ]
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
    const maxIterations =
      Number.isFinite(maxIterationsRaw) && maxIterationsRaw > 0 ? Math.floor(maxIterationsRaw) : 10

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

    // 输出契约声明（2026-10-07 R5）：json 字符串或对象两种形态都收
    //（与 llm.node 同约定）。解析失败即抛——保存不阻断（不进拓扑校验），
    // 运行时诚实失败，属可恢复的配置笔误。
    const schemaRaw = nodeData.inputs?.outputSchema
    let responseSchema: Record<string, unknown> | undefined
    if (typeof schemaRaw === 'string' && schemaRaw.trim().length > 0) {
      try {
        responseSchema = JSON.parse(schemaRaw) as Record<string, unknown>
      } catch {
        throw new Error('Agent 节点的 outputSchema 不是合法 JSON——请修正节点配置')
      }
    } else if (schemaRaw && typeof schemaRaw === 'object') {
      responseSchema = schemaRaw as Record<string, unknown>
    }

    const messages: IChatMessage[] = [{ role: 'system', content: systemPrompt }]
    // schema 契约块编进 system 头（与 LLM 节点同语义）：Agent 过程可自由调
    // 工具，但最终交付钉死为合规 JSON。resume 修复轮只发增量消息，CLI 会话
    // 文件自持本块（buildCliMessages 对增量轮产出 systemPrompt=undefined，
    // 不会重复注入）。
    if (responseSchema) {
      messages.unshift({
        role: 'system',
        content:
          '你的最终交付必须是（且只是）一个符合以下 JSON Schema 的 JSON 对象——最终答案' +
          '只输出该 JSON 本体，不要用 Markdown 代码块包裹、不要附加任何其他文字' +
          '（过程中可正常使用工具）：\n' +
          JSON.stringify(responseSchema, null, 2),
      })
    }
    if (userMessage.length > 0) {
      messages.push({ role: 'user', content: userMessage })
    }

    const recordedInput = {
      agentId,
      agentName: agentConfig.name,
      model,
      systemPrompt,
      userMessage,
      maxIterations,
      skills: agentConfig.skills ?? [],
      toolsAvailable: tools.map((t) => t.function.name),
    }

    const llmClient = options.llmClient
    const loopArgs = {
      llmClient,
      model,
      messages,
      tools,
      toolRegistry,
      maxIterations,
      signal: options.signal,
      onNodeDelta: options.onNodeDelta,
      nodeId: nodeData.id,
      // R8：实例序号（汇点键）——frozen agent 声明的 model 即 pin 判定信号
      //（runToolLoop 内按 args.model 置位 modelPinned）。
      nodeOrdinal: options.nodeOrdinal,
    }

    // ── 未声明 outputSchema：现状路径，行为逐字节不变 ──
    if (!responseSchema) {
      const loop = await this.runToolLoop(loopArgs)
      let finalText = loop.finalText
      // If we exited the loop because the iteration budget was exhausted while
      // the model still wanted tools, surface a trailing note so the trace
      // makes clear the run was truncated rather than finished.
      if (loop.truncated) {
        finalText =
          finalText +
          `\n\n[Platform Agent reached the maxIterations (${maxIterations}) limit while tools were still pending]`
      }
      // 空产出守卫（与 llm.node 一致）：Agent 一轮跑完没有任何正文几乎必然
      // 是异常（CLI 截断、指令与输入错位）。诚实失败优于空壳成功流向下游。
      if (finalText.trim().length === 0) {
        throw new Error(`Agent 节点「${agentConfig.name}」返回空内容 — 请检查 Agent 指令与上游输入`)
      }
      return {
        id: nodeData.id,
        name: this.name,
        input: recordedInput,
        output: {
          text: finalText,
          content: finalText,
          ...(loop.resolvedModel ? { resolvedModel: loop.resolvedModel } : {}),
        },
        usage: loop.usage,
      }
    }

    // ── 三值裁决状态机（2026-10-07 R5）──
    // 声明了 outputSchema：每轮跑一次工具循环（独立 maxIterations 预算），
    // 裁决三分支 accept / violations / no-deliverable；修复与 NUDGE 各至多
    // 一次（类型去重），总交互预算 VERDICT_MAX_INTERACTIONS。轮次活动经
    // onNodeDelta 发 kind:'verdict'（可观测契约），不新开 span 段。
    const emitVerdict = (label: string, detail?: string): void => {
      options.onNodeDelta?.({ type: 'activity', kind: 'verdict', label, detail })
    }

    let round = 0
    let usedRepair = false
    let usedNudge = false
    let lastSessionId: string | undefined
    let totalUsage: ITokenUsage | undefined

    for (;;) {
      round += 1
      // 修复/NUDGE 轮不传 tools（设计定稿：修复轮目标是交付格式合规的最终
      // JSON，给工具只会再引入截断风险）——空工具表让循环裸跑一次 chat 即终。
      const loop = await this.runToolLoop({
        ...loopArgs,
        tools: round === 1 ? tools : [],
        ...(lastSessionId ? { resumeSessionId: lastSessionId } : {}),
      })
      totalUsage = accumulateUsage(totalUsage, loop.usage)
      // 每轮更新（缺席即清空）：resume 轮一旦失去会话能力（后端没回
      // sessionId），后续轮自动落回放档——不沿用陈旧会话 id。
      lastSessionId = loop.sessionId

      const verdict = adjudicate(loop.finalText, loop.truncated, responseSchema)

      if (verdict.kind === 'accept') {
        // 首轮直收零裁决活动（没发生任何轮次就没有可审计的东西）；后续轮
        // 的 accept 照发——回放要能读出「修复在第 N 轮生效」。
        if (round > 1) emitVerdict(`第 ${round} 轮裁决：accept（合规收下）`)
        return {
          id: nodeData.id,
          name: this.name,
          input: recordedInput,
          // {{id.json}} 天然可引用（模板按点路径取输出对象的 json 键）
          output: {
            text: loop.finalText,
            content: loop.finalText,
            json: verdict.parsed,
            ...(loop.resolvedModel ? { resolvedModel: loop.resolvedModel } : {}),
          },
          usage: totalUsage,
        }
      }

      const verdictLabel =
        verdict.kind === 'violations'
          ? `第 ${round} 轮裁决：violations（${verdict.issues.length} 项违规）`
          : `第 ${round} 轮裁决：no-deliverable（未交付）`
      emitVerdict(
        verdictLabel,
        verdict.kind === 'violations' ? verdict.issues.map(issueLine).join('\n') : undefined,
      )

      // 回喂选择：优先与裁决同型的回喂（violations→修复 / no-deliverable→
      // NUDGE）；同型已用尽时退用另一型（预算内的最后一搏——恒违规场景走满
      // 原始+修复+NUDGE 三次）。两型都耗尽或轮次已达上限 → 诚实失败。
      const canRepair = verdict.kind === 'violations' && !usedRepair
      const canNudge = !usedNudge
      if (round >= VERDICT_MAX_INTERACTIONS || (!canRepair && !canNudge)) {
        const detail =
          verdict.kind === 'violations'
            ? verdict.issues.map(issueLine).join('\n')
            : '多轮追问后仍无正文交付'
        emitVerdict(`裁决预算耗尽（${VERDICT_MAX_INTERACTIONS} 次交互），节点诚实失败`, detail)
        // 拒绝档（集成裁决 2026-10-08，R9d 对照表「节点拒绝」档）：outputSchema
        // 契约不符是可调整后重试的声明型失败（改 prompt/schema），不整体翻红
        // ——NodeRejectedError → isolateFailure 管道 → run partial_success。
        if (verdict.kind === 'violations') {
          throw new NodeRejectedError(
            `节点被拒绝：Agent 节点「${agentConfig.name}」输出不符合 outputSchema（裁决预算 ` +
              `${VERDICT_MAX_INTERACTIONS} 次交互耗尽，不降级收下）：\n` +
              verdict.issues.map(issueLine).join('\n'),
          )
        }
        throw new NodeRejectedError(
          `节点被拒绝：Agent 节点「${agentConfig.name}」未交付符合 outputSchema 的产出——裁决预算` +
            `（至多 ${VERDICT_MAX_INTERACTIONS} 次交互）内修复回喂与追问均已用尽，` +
            '诚实失败而非空壳成功',
        )
      }

      // 回喂消息（assistant 回显 + user 追加进既有数组——回放档的全量真
      // 相源；resume 档只把增量 user 消息递给后端，assistant 回显由 CLI 会
      // 话文件自持，不重复注入）。
      let feedUser: string
      if (verdict.kind === 'violations' && canRepair) {
        usedRepair = true
        feedUser =
          '你上一条输出不符合节点 outputSchema，违规明细（路径/期望/实际）：\n' +
          verdict.issues.map(issueLine).join('\n') +
          '\n请重新输出——只输出修正后的 JSON，不要任何其他文字、不要调用工具。'
      } else {
        usedNudge = true
        feedUser =
          '本轮未交付最终结果（工具调用预算耗尽或无正文）。请立即停止调用工具，' +
          '直接输出符合本节点 outputSchema 的最终 JSON——只输出 JSON 本体。'
      }

      // 会话延续（能力披露协议）：只看上一轮 chat 返回是否带 sessionId——
      // 带 → 原样透传该后端真实会话 id（--resume 同会话修复，只发增量）；
      // 不带 → messages 全量回放（逻辑会话）+「会话重建」活动行留痕。
      const resume = Boolean(lastSessionId)
      const modeLabel = resume ? '同会话 --resume' : '会话重建·对话回放'
      emitVerdict(
        `第 ${round + 1} 轮 · ${canRepair ? '违规修复回喂' : '未交付追问'}（${modeLabel}）`,
        feedUser,
      )
      messages.push({ role: 'assistant', content: loop.finalText || '(本轮无正文输出)' })
      const feedMessage: IChatMessage = { role: 'user', content: feedUser }
      messages.push(feedMessage)
      // resume 档把 messages 切到「只含本轮增量」——但全量数组保持累积，
      // 后端后续轮次失去会话能力时回放档仍有完整真相源。
      if (resume) {
        loopArgs.messages = [feedMessage]
      } else {
        loopArgs.messages = messages
      }
    }
  }

  /**
   * Tool-calling loop（2026-10-07 R5 从 run() 提出）：call the LLM, execute
   * any requested tools, feed the results back, and repeat until the model
   * replies without tool calls or the iteration budget is exhausted.
   * 纯搬运（行为不变）：返回 truncated = 「maxIterations 耗尽且工具仍
   * pending」（原尾注分支条件），尾注拼接留在调用方；sessionId 透传最后
   * 一次 chat 的后端会话 id（能力披露协议）。
   */
  private async runToolLoop(args: {
    llmClient: NonNullable<IExecutionContext['llmClient']>
    model: string
    messages: IChatMessage[]
    tools: IToolSchema[]
    toolRegistry: Record<string, IAgentTool>
    maxIterations: number
    signal?: AbortSignal
    onNodeDelta?: (chunk: IStreamDelta) => void
    nodeId: string
    resumeSessionId?: string
    /** per-node 实例序号（R8 §3.6(a)）：CLI 汇点键 runId:nodeId:ordinal。 */
    nodeOrdinal?: number
  }): Promise<{
    finalText: string
    truncated: boolean
    usage: ITokenUsage | undefined
    sessionId?: string
    resolvedModel?: string
  }> {
    const { llmClient, model, messages, tools, toolRegistry, maxIterations, nodeId } = args

    let finalText = ''
    let totalUsage: ITokenUsage | undefined
    let iterations = 0
    let lastToolCallIds: string[] = []
    let sessionId: string | undefined
    // resolved model（R8 §3.6(c)）：CLI = cli:<kind>；HTTP = 实际请求 model。
    let resolvedModel: string | undefined

    while (iterations < maxIterations) {
      iterations += 1
      const result = await llmClient.chat({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        signal: args.signal,
        // CLI 后端逐事件转发 text delta —— 工具循环的每一轮生成过程都
        // 可被旁观端看到（live tail），不再等到节点收尾才见产出。
        onDelta: args.onNodeDelta,
        // 可操作终端（2026-09-08）：上报调用方节点 id —— 工具循环每轮新建
        // CLI 会话，汇点表按 nodeId 覆盖登记，插话永远路由到最新会话。
        nodeId,
        // R5 会话延续：非空 = CLI 后端以 --resume 恢复该会话（只发增量）。
        ...(args.resumeSessionId ? { resumeSessionId: args.resumeSessionId } : {}),
        // R8（§3.6(a)(d)）：实例序号（汇点键 runId:nodeId:ordinal）+ 模型
        // pin 位（frozen agent 声明 model 时禁降级）。
        ordinal: args.nodeOrdinal,
        ...(args.model ? { modelPinned: true } : {}),
      })
      if (result.sessionId) sessionId = result.sessionId
      if (result.model) resolvedModel = result.model
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
            const toolArgs = parseToolArgs(tc.function.arguments)
            toolResult = await tool.handler(toolArgs)
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

    return {
      finalText,
      truncated: iterations >= maxIterations && lastToolCallIds.length > 0,
      usage: totalUsage,
      sessionId,
      resolvedModel,
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

/** 三值裁决判据（设计定稿，docs/zcode-borrow/design-verdict.md §3.1）。 */
type VerdictOutcome =
  | { kind: 'accept'; parsed: unknown }
  | { kind: 'violations'; issues: SchemaIssue[] }
  | { kind: 'no-deliverable' }

/**
 * 裁决函数：accept（JSON 可解析且 schema 校验空）/ violations（解析失败或
 * 校验非空）/ no-deliverable（截断或空文本）。**截断优先于文本内容**——
 * maxIterations 耗尽意味着模型没有交付最终答案，NUDGE（「停止调工具，直接
 * 交付」）语义精确；残余文本再违规也不进 violations（修格式救不了没干完
 * 的活）。
 */
function adjudicate(
  text: string,
  truncated: boolean,
  schema: Record<string, unknown>,
): VerdictOutcome {
  if (truncated || text.trim().length === 0) return { kind: 'no-deliverable' }
  try {
    const parsed = extractJsonFromText(text)
    const issues = validateAgainstSchema(parsed, schema)
    if (issues.length === 0) return { kind: 'accept', parsed }
    return { kind: 'violations', issues }
  } catch (err) {
    return {
      kind: 'violations',
      issues: [
        {
          path: '$',
          message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
          expected: 'JSON 对象',
          got: text.trim().slice(0, 80),
        },
      ],
    }
  }
}

/** issue → 「- path：期望 X，实际 Y」行（回喂消息与诚实失败错误共用）。 */
function issueLine(i: SchemaIssue): string {
  return `- ${i.path}：期望 ${i.expected ?? i.message}，实际 ${i.got ?? '（见消息）'}`
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
