/**
 * context-budget —— LLM 节点的上下文总预算分配器（2026-10-04 P1a）。
 *
 * 调研裁决（docs/context-management-research.md）：把「各块独立上限」升级为
 * 「总预算 + 取舍序」——dsh agent-instructions 的原则：宽泛的先丢、最特定
 * 的最后截。对 LLM 节点，各块的牺牲序（先丢 → 后保）：
 *
 *   检索历史（最宽泛）→ 上游合并输入（核心工作数据，头尾保真截断）
 *   → flow 上下文（特定）→ system+prompt+schema（常驻，不裁只如实标记超限）
 *
 * 字符制近似 token（ECC：散文 words×1.3 / 代码 chars÷4 的中庸近似——引擎
 * DB-free 不引 tokenizer）。每步裁剪都留对账标记，最终账目进节点输出
 * （span 可查），与 64KB 合并截断同一风格：不静默。
 */

export interface ContextBudgetAccounting {
  /** 本次组装的总预算（字符）。 */
  capChars: number
  /** 常驻块（system+prompt+schema）字符数——不裁。 */
  fixedChars: number
  /** flow 上下文注入字符数（含截断标记）。 */
  flowContextChars: number
  /** 上游输入注入字符数（含截断标记）。 */
  inputChars: number
  /** 检索历史：注入条数 / 丢弃条数 / 注入字符数（含摘要块）。 */
  historyIncluded: number
  historyDropped: number
  historyChars: number
  /** 常驻块自身超预算（诚实标记：这类超限裁历史无意义，需改节点配置）。 */
  overBudget: boolean
  /** 各步对账标记（进 span，审计用）。 */
  notes: string[]
}

export interface AssembleBudgetInput {
  /** 组装总预算（字符）。 */
  capChars: number
  /** 常驻：已解析的 system prompt 与 prompt 模板（不可裁）。 */
  systemPrompt: string
  prompt: string
  /** 常驻：输出契约的 JSON 序列化（不可裁，体积小）。 */
  schemaJson?: string
  /** flow 上下文（宿主已按自身子预算预裁，这里兜底）。 */
  flowContext?: string
  /** 上游合并输入文本（牺牲序第二：超限头尾保真截断）。 */
  inputText: string
  /** 检索历史消息（牺牲序第一：从排名末尾开始丢——检索器按相关性排序）。 */
  historyMessages: Array<{ role: string; content: string }>
  /** 滚动会话摘要块（牺牲序一之内、消息之前丢——摘要比原文宽泛）。 */
  historySummary?: string | null
}

export interface AssembleBudgetResult {
  /** 最终 user 消息正文（prompt + 预算内输入）。 */
  userContent: string
  /** flow 上下文注入块（空串 = 不注入）。 */
  flowContextBlock: string
  /** 预算内历史消息（已丢尾）。 */
  historyUsed: Array<{ role: string; content: string }>
  /** 预算内摘要（超预算先于任何消息丢弃）。 */
  summaryUsed: string | null
  accounting: ContextBudgetAccounting
}

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** LLM 节点组装总预算（字符）。节点级 `contextCap` 输入可覆盖。 */
export const DEFAULT_CONTEXT_CAP = (): number => numEnv('DAGENTS_LLM_NODE_CONTEXT_CAP', 131_072)

/**
 * 头尾保真截断（P1a 统一策略）：构建/测试类输出的结论在末尾（openworker
 * 洞察），纯保头会切掉判决——保头 60% + 对账标记 + 保尾 40%。
 */
export function tailPreservingTruncate(
  text: string,
  cap: number,
  label: string,
  notes?: string[],
): string {
  if (cap <= 0 || text.length <= cap) return text
  const head = Math.floor(cap * 0.6)
  const tail = Math.floor(cap * 0.4)
  notes?.push(`${label}: ${text.length} 字符超上限 ${cap}，保头 ${head} + 保尾 ${tail}`)
  return (
    text.slice(0, head) +
    `\n\n[${label}截断：全文 ${text.length} 字符，上限 ${cap}——中间省略约 ${text.length - head - tail} 字符]\n\n` +
    text.slice(text.length - tail)
  )
}

/** 按总预算组装 LLM 节点的上下文块（纯函数，单测钉语义）。 */
export function assembleUnderBudget(input: AssembleBudgetInput): AssembleBudgetResult {
  const notes: string[] = []
  const schemaChars = input.schemaJson?.length ?? 0
  // flow 上下文先计入常驻（宿主已预裁，这里只兜底防呆）
  const flowContextBlock =
    input.flowContext && input.flowContext.trim().length > 0
      ? `【流程上下文】\n${input.flowContext.trim()}`
      : ''
  const fixedChars =
    input.systemPrompt.length + input.prompt.length + schemaChars + flowContextBlock.length
  const overBudget = fixedChars > input.capChars
  if (overBudget) {
    notes.push(
      `常驻块（system+prompt+schema+flowContext）${fixedChars} 字符已超总预算 ${input.capChars}——` +
        `历史与输入将不注入；请精简节点 prompt 或调大 contextCap`,
    )
  }

  // ── 牺牲序一：检索历史（摘要先丢，再从排名末尾丢消息）──
  let remaining = input.capChars - fixedChars
  let summaryUsed: string | null = null
  let historyUsed: Array<{ role: string; content: string }> = []
  let historyDropped = 0
  if (!overBudget && input.historyMessages.length + (input.historySummary ? 1 : 0) > 0) {
    const blocks: Array<{ role: string; content: string }> = input.historyMessages.map((m) => ({
      role: m.role,
      content: `[${m.role}] ${m.content}`,
    }))
    // 摘要块排最前（丢它优先于丢原文消息——摘要是最宽泛的形态）
    if (input.historySummary && input.historySummary.trim().length > 0) {
      blocks.unshift({ role: 'system', content: `【会话摘要】${input.historySummary.trim()}` })
    }
    const kept: typeof blocks = []
    let used = 0
    for (let i = 0; i < blocks.length; i++) {
      const cost = blocks[i].content.length + 2
      if (used + cost <= remaining) {
        kept.push(blocks[i])
        used += cost
        continue
      }
      if (i === 0 && blocks[0].content.startsWith('【会话摘要】')) {
        // 摘要块放不下：丢弃摘要、继续尝试原文消息（摘要先丢的语义——
        // 不能让一个大摘要把后面放得下的短消息全部饿死）
        notes.push(`会话摘要（${blocks[0].content.length} 字符）超出剩余预算，先丢弃`)
        continue
      }
      // 排名靠后的消息放不下：到此为止（前缀即最相关集）
      historyDropped = blocks.length - i
      if (historyDropped > 0)
        notes.push(`检索历史超出剩余预算，丢弃排名靠后的 ${historyDropped} 块`)
      break
    }
    // 摘要块若被保留，从消息里拆出来单独注入
    const summaryBlock = kept[0]?.content.startsWith('【会话摘要】') ? kept.shift() : undefined
    summaryUsed = summaryBlock ? summaryBlock.content : null
    historyUsed = kept
    remaining -= used
  }

  // ── 牺牲序二：上游输入（头尾保真截断到剩余额度）──
  let inputText = input.inputText
  if (overBudget) {
    // 常驻已超限：输入不注入（裁它也救不了 system/prompt 的超限）
    if (inputText.length > 0) notes.push('上游输入因常驻块超预算未注入')
    inputText = ''
  } else if (inputText.length > 0 && remaining < inputText.length) {
    inputText = tailPreservingTruncate(inputText, Math.max(remaining, 0), '上游输入', notes)
  }

  const userContent = inputText.length > 0 ? `${input.prompt}\n\n${inputText}` : input.prompt

  return {
    userContent,
    flowContextBlock,
    historyUsed,
    summaryUsed,
    accounting: {
      capChars: input.capChars,
      fixedChars,
      flowContextChars: flowContextBlock.length,
      inputChars: inputText.length,
      historyIncluded: historyUsed.length,
      historyDropped,
      historyChars:
        historyUsed.reduce((n, m) => n + m.content.length, 0) + (summaryUsed?.length ?? 0),
      overBudget,
      notes,
    },
  }
}
