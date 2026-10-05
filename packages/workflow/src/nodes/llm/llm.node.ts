import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'
import { extractJsonFromText, validateAgainstSchema } from '../../utils/json-schema-lite.js'
import { assembleUnderBudget, DEFAULT_CONTEXT_CAP } from '../../utils/context-budget.js'

/**
 * LLM node — calls a large language model with system and user prompts.
 *
 * Resolves template variables in prompts from runtime state before sending
 * to the LLM client.
 *
 * Streaming: when the node is the flow's last node, an SSE streamer is
 * present, and the LLM client implements `chatStream`, the response is
 * streamed token-by-token to the client as it generates (falling back to a
 * single `chat` call otherwise).
 */
export class LLMNode implements INode {
  label = 'LLM'
  name = 'llmAgentflow'
  version = 1
  type = 'LLM'
  category = 'agent'
  color = '#8b5cf6'
  inputs = [
    {
      label: 'Model',
      name: 'model',
      type: 'options' as const,
      required: true,
      default: '',
    },
    {
      label: 'System Prompt',
      name: 'systemPrompt',
      type: 'code' as const,
      rows: 4,
      default: '',
    },
    {
      label: 'Prompt',
      name: 'prompt',
      type: 'code' as const,
      rows: 4,
      required: true,
      default: '',
    },
    {
      label: 'Temperature',
      name: 'temperature',
      type: 'number' as const,
      default: 0.7,
    },
    {
      label: 'Output Schema (JSON)',
      name: 'outputSchema',
      type: 'json' as const,
      rows: 6,
      default: '',
      description:
        '可选 JSON Schema：要求模型只输出符合该结构的 JSON。命中后输出带 `json` 字段（模板 {{id.json}}），并做一轮格式修复重试',
    },
    {
      label: 'Include Chat History',
      name: 'includeChatHistory',
      type: 'number' as const,
      default: 0,
      description:
        '可选：注入最近 N 条会话消息 + 滚动会话摘要作上下文（0=不注入；需宿主提供检索器，chat 路径生效）',
    },
    {
      label: 'Context Cap (chars)',
      name: 'contextCap',
      type: 'number' as const,
      default: 0,
      description:
        '可选：本节点上下文总预算（字符，0=默认 DAGENTS_LLM_NODE_CONTEXT_CAP/131072）——常驻不裁，超限依次丢历史、截上游输入（对账进 span）',
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const model = (nodeData.inputs?.model as string) ?? ''
    const systemPrompt = (nodeData.inputs?.systemPrompt as string) ?? ''
    const prompt = (nodeData.inputs?.prompt as string) ?? ''
    const temperature = (nodeData.inputs?.temperature as number) ?? 0.7
    // 输出契约（2026-10-04）：json 字符串或对象两种形态都收
    const schemaRaw = nodeData.inputs?.outputSchema
    let responseSchema: Record<string, unknown> | undefined
    if (typeof schemaRaw === 'string' && schemaRaw.trim().length > 0) {
      try {
        responseSchema = JSON.parse(schemaRaw) as Record<string, unknown>
      } catch {
        throw new Error('LLM 节点的 outputSchema 不是合法 JSON——请修正节点配置')
      }
    } else if (schemaRaw && typeof schemaRaw === 'object') {
      responseSchema = schemaRaw as Record<string, unknown>
    }
    // 会话上下文（2026-10-04）：声明条数 > 0 且宿主注入了检索器才注入
    const historyTurnsRaw = Number(nodeData.inputs?.includeChatHistory)
    const historyTurns = Number.isFinite(historyTurnsRaw)
      ? Math.min(Math.max(Math.trunc(historyTurnsRaw), 0), 50)
      : 0

    const resolvedSystemPrompt = resolveVariables(systemPrompt, options.state) as string
    const resolvedPrompt = resolveVariables(prompt, options.state) as string

    // 上游合并输入文本（多上游时 mergeInputs 把全部 content 拼进 `content`；
    // `text` 被覆盖只剩一份——优先 `content`，否则 N 进 1 只看到 1/N 产出）。
    let inputText = ''
    if (typeof input === 'string' && input.length > 0) {
      inputText = input
    } else if (typeof input === 'object' && input !== null) {
      const rec = input as Record<string, unknown>
      const content = typeof rec.content === 'string' ? rec.content : ''
      const text = typeof rec.text === 'string' ? rec.text : ''
      inputText = content.length > 0 ? content : text
    }

    if (!options.llmClient) {
      throw new Error('LLM client is not available in execution context')
    }

    // ── 上下文总预算分配制（2026-10-04 P1a）──
    // 常驻（system+prompt+schema+flowContext）→ 上游输入（头尾保真截断）
    // → 检索历史（摘要块最先丢、再丢排名靠后的消息）。账目进输出对账。
    const capRaw = Number(nodeData.inputs?.contextCap)
    const capChars =
      Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : DEFAULT_CONTEXT_CAP()

    let summaryUsed: string | null = null
    let historyUsed: Array<{ role: string; content: string }> = []
    if (historyTurns > 0 && options.historyRetriever) {
      try {
        const retrieved = await options.historyRetriever(resolvedPrompt, {
          chatId: options.chatId,
          limit: historyTurns,
        })
        // 契约升级（P1b 两级历史）：摘要（滚动 checkpoint）+ 原文消息混合
        summaryUsed = retrieved.summary ?? null
        historyUsed = retrieved.messages ?? []
      } catch {
        // 检索失败不阻塞生成——上下文增强是增益不是依赖
      }
    }

    const assembled = assembleUnderBudget({
      capChars,
      systemPrompt: resolvedSystemPrompt,
      prompt: resolvedPrompt,
      schemaJson: responseSchema ? JSON.stringify(responseSchema, null, 2) : undefined,
      flowContext: options.flowContext,
      inputText,
      historyMessages: historyUsed,
      historySummary: summaryUsed,
    })

    // 实际下发的 user 正文（prompt + 合并上游输入 + 预算截断对账标记）。
    // span 的 input.prompt 记这个而非裸 resolvedPrompt——2026-08-27 菱形合并
    // 语义：N 进 1 的 sink 节点 span 必须能看到全部上游简报（轨迹 Inspector
    // 与 e2e WF-09 都钉这一点）；预算改造把上游从 prompt 拆进 inputText 后，
    // 裸 resolvedPrompt 只剩节点模板，上游不可见。
    const effectivePrompt = assembled.userContent

    const messages: Array<{ role: string; content: string }> = []

    // 两级历史注入（P1b）：摘要块（滚动 checkpoint，宽泛）+ 原文消息
    // （按相关性排序）——摘要先于原文被预算丢弃。
    if (assembled.summaryUsed) {
      messages.push({
        role: 'system',
        content: `以下是本会话的先前上下文摘要（更早的对话已浓缩，细节以最近消息为准）：\n\n${assembled.summaryUsed}`,
      })
    }
    if (assembled.historyUsed.length > 0) {
      const block = assembled.historyUsed.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
      messages.push({
        role: 'system',
        content: `以下是本会话的近期上下文（按相关性排序，仅供参考）：\n\n${block}`,
      })
    }

    // system = flow 上下文块（P2a）+ 节点 systemPrompt——flow 上下文进常驻预算
    const systemParts: string[] = []
    if (assembled.flowContextBlock) systemParts.push(assembled.flowContextBlock)
    if (resolvedSystemPrompt.length > 0) systemParts.push(resolvedSystemPrompt)
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') })
    }
    messages.push({ role: 'user', content: assembled.userContent })

    // 输出契约：schema 编进 system 尾部（provider 无关——HTTP 与 CLI 同语义）；
    // 声明了契约就不走流式（格式修复重试无法撤回已推送的增量）。
    if (responseSchema) {
      messages.unshift({
        role: 'system',
        content:
          '你必须只输出一个符合以下 JSON Schema 的 JSON 对象（不要输出任何其他文字、' +
          '不要用 Markdown 代码块包裹）：\n' +
          JSON.stringify(responseSchema, null, 2),
      })
    }

    // 流式条件（2026-08-30 放宽）：只要 llmClient 实现了 chatStream 就走
    // 流式 —— 此前要求 isLastNode + sseStreamer（只有 chat 触发的末节点
    // 能流），画布/详情旁观路径完全黑箱。现在每个 delta 除（末节点的）
    // SSE token 外还回调 onNodeDelta（宿主节流落库 → 轮询端 live tail）。
    // 输出契约模式例外（见上）。
    const streamable = options.llmClient.chatStream !== undefined && !responseSchema

    let text = ''
    let usage: import('../../types/index.js').ITokenUsage | undefined
    if (streamable) {
      let accumulated = ''
      for await (const chunk of options.llmClient.chatStream!({
        model,
        messages,
        temperature,
        signal: options.signal,
        // 可操作终端（2026-09-08）：上报调用方节点 —— CLI 宿主据此把会话
        // 登记进插话汇点表；onDelta 供插话送达后回写 user_input 事件。
        nodeId: nodeData.id,
        onDelta: options.onNodeDelta,
      })) {
        if (chunk.delta && chunk.delta.length > 0) {
          accumulated += chunk.delta
          // 末节点 + chat SSE 订阅 → 逐 token 推给聊天界面（原行为）
          if (options.isLastNode && options.sseStreamer) {
            options.sseStreamer.streamTokenEvent(options.chatId, chunk.delta)
          }
          options.onNodeDelta?.({ type: 'text', text: chunk.delta })
        }
        if (chunk.usage) {
          usage = chunk.usage
        }
      }
      text = accumulated
    } else {
      let repairMessages = messages
      let schemaIssues: import('../../utils/json-schema-lite.js').SchemaIssue[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await options.llmClient.chat({
          model,
          messages: repairMessages,
          temperature,
          signal: options.signal,
          onDelta: options.onNodeDelta,
          // 可操作终端（2026-09-08）：上报调用方节点 id（插话汇点登记）
          nodeId: nodeData.id,
          ...(responseSchema ? { responseSchema } : {}),
        })
        text = result.text
        usage = result.usage
        if (!responseSchema) break
        // 契约校验（2026-10-04）：解析 + 子集校验；失败带错误清单喂回模型
        // 做一轮修复重试（只修一轮——反复修不好就该让节点失败）。
        try {
          const parsed = extractJsonFromText(text)
          schemaIssues = validateAgainstSchema(parsed, responseSchema)
          if (schemaIssues.length === 0) {
            return {
              id: nodeData.id,
              name: this.name,
              input: {
                model,
                systemPrompt: resolvedSystemPrompt,
                prompt: effectivePrompt,
                temperature,
              },
              output: { text, content: text, json: parsed },
              usage,
            }
          }
        } catch (err) {
          schemaIssues = [
            {
              path: '$',
              message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ]
        }
        if (attempt === 0) {
          repairMessages = [
            ...messages,
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                `你上一条输出不符合约定的 JSON Schema，问题如下：\n` +
                schemaIssues.map((i) => `- ${i.path}: ${i.message}`).join('\n') +
                `\n请重新输出——只输出修正后的 JSON，不要任何其他文字。`,
            },
          ]
        }
      }
      if (responseSchema && schemaIssues.length > 0) {
        throw new Error(
          `LLM 节点输出不符合 outputSchema（修复重试后仍失败）：` +
            schemaIssues
              .slice(0, 5)
              .map((i) => `${i.path}: ${i.message}`)
              .join('；'),
        )
      }
    }

    // 空产出守卫：CLI/HTTP 返回空文本几乎必然是异常（CLI agent 干了活但
    // 没输出正文、上游全部丢失等）。静默标记 done 会让下游拿到空壳成功
    // ——宁可诚实失败，让运行卡在具名节点上（真实复跑曾出现 180s 后
    // content="" 且 status=done 的空成功）。
    if (text.trim().length === 0) {
      throw new Error(`LLM 节点返回空内容（model=${model || 'default'}）— 请检查上游输入与模型配置`)
    }

    // 未解析占位符留痕（PRD FR-02/验收）：解析后仍以字面量送达模型的
    // `{{...}}` 计数 —— 落进 span 后「变量一次成功率」可查询可度量。
    // 启发式（正文里合法出现花括号会误计），只做计数不判失败。
    const unresolved = [
      ...resolvedPrompt.matchAll(/\{\{([^}]+)\}\}/g),
      ...resolvedSystemPrompt.matchAll(/\{\{([^}]+)\}\}/g),
    ].map((mt) => mt[1].trim())

    return {
      id: nodeData.id,
      name: this.name,
      input: { model, systemPrompt: resolvedSystemPrompt, prompt: effectivePrompt, temperature },
      output: {
        text,
        content: text,
        contextBudget: assembled.accounting,
        ...(unresolved.length > 0 ? { unresolvedPlaceholders: unresolved.slice(0, 5) } : {}),
      },
      usage,
    }
  }
}
