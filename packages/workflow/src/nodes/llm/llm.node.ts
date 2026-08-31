import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

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
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const model = (nodeData.inputs?.model as string) ?? ''
    const systemPrompt = (nodeData.inputs?.systemPrompt as string) ?? ''
    const prompt = (nodeData.inputs?.prompt as string) ?? ''
    const temperature = (nodeData.inputs?.temperature as number) ?? 0.7

    const resolvedSystemPrompt = resolveVariables(systemPrompt, options.state) as string
    let resolvedPrompt = resolveVariables(prompt, options.state) as string

    if (typeof input === 'string' && input.length > 0) {
      resolvedPrompt = `${resolvedPrompt}\n\n${input}`
    } else if (typeof input === 'object' && input !== null) {
      // 多上游合并时 mergeInputs 把全部上游 content 拼进 `content`，而
      // `text` 被 Object.assign 用最后一条边覆盖只剩一份 —— 必须优先取
      // `content`，否则 N 进 1 的 LLM 节点只看到 1/N 的上游产出
      // （真实复跑「产品发现（并行）」时汇总节点丢 3/4 简报的根因）。
      const rec = input as Record<string, unknown>
      const content = typeof rec.content === 'string' ? rec.content : ''
      const text = typeof rec.text === 'string' ? rec.text : ''
      const inputText = content.length > 0 ? content : text
      if (inputText.length > 0) {
        resolvedPrompt = `${resolvedPrompt}\n\n${inputText}`
      }
    }

    if (!options.llmClient) {
      throw new Error('LLM client is not available in execution context')
    }

    const messages: Array<{ role: string; content: string }> = []
    if (resolvedSystemPrompt.length > 0) {
      messages.push({ role: 'system', content: resolvedSystemPrompt })
    }
    messages.push({ role: 'user', content: resolvedPrompt })

    // 流式条件（2026-08-30 放宽）：只要 llmClient 实现了 chatStream 就走
    // 流式 —— 此前要求 isLastNode + sseStreamer（只有 chat 触发的末节点
    // 能流），画布/详情旁观路径完全黑箱。现在每个 delta 除（末节点的）
    // SSE token 外还回调 onNodeDelta（宿主节流落库 → 轮询端 live tail）。
    const streamable = options.llmClient.chatStream !== undefined

    let text: string
    let usage: import('../../types/index.js').ITokenUsage | undefined
    if (streamable) {
      let accumulated = ''
      for await (const chunk of options.llmClient.chatStream!({
        model,
        messages,
        temperature,
        signal: options.signal,
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
      const result = await options.llmClient.chat({
        model,
        messages,
        temperature,
        signal: options.signal,
        onDelta: options.onNodeDelta,
      })
      text = result.text
      usage = result.usage
    }

    // 空产出守卫：CLI/HTTP 返回空文本几乎必然是异常（CLI agent 干了活但
    // 没输出正文、上游全部丢失等）。静默标记 done 会让下游拿到空壳成功
    // ——宁可诚实失败，让运行卡在具名节点上（真实复跑曾出现 180s 后
    // content="" 且 status=done 的空成功）。
    if (text.trim().length === 0) {
      throw new Error(
        `LLM 节点返回空内容（model=${model || 'default'}）— 请检查上游输入与模型配置`,
      )
    }

    // 未解析占位符留痕（PRD FR-02/验收）：解析后仍以字面量送达模型的
    // `{{...}}` 计数 —— 落进 span 后「变量一次成功率」可查询可度量。
    // 启发式（正文里合法出现花括号会误计），只做计数不判失败。
    const unresolved = [
      ...resolvedPrompt.matchAll(/\{\{([^}]+)\}\}/g),
      ...(resolvedSystemPrompt.matchAll(/\{\{([^}]+)\}\}/g)),
    ].map((mt) => mt[1].trim())

    return {
      id: nodeData.id,
      name: this.name,
      input: { model, systemPrompt: resolvedSystemPrompt, prompt: resolvedPrompt, temperature },
      output: unresolved.length > 0
        ? { text, content: text, unresolvedPlaceholders: unresolved.slice(0, 5) }
        : { text, content: text },
      usage,
    }
  }
}
