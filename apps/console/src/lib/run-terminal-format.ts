/**
 * run-terminal-format.ts —— 运行终端视图的纯派生层。
 *
 * 把 run_node_spans 行（node-spans 端点的 camelCase 形状）映射成
 * RunTerminal 组件的 section/line 结构（2026-09-06 终端视图 PRD）：
 *  - `events`（span-writer 全量过程日志，2026-09-06 起落库）是终端行序的
 *    首选数据源；旧运行 / running 早期只有 `activity` 环（策展缓存），
 *    降级用它 —— 行内容是 summary 级摘要，不是全文（全文在那之后的
 *    运行里才采集）。
 *  - 正文提取与画布摘要面板同语义（text/content 直出 + DirectReply 的
 *    字符串化 JSON 二次解包），但**不截断** —— 终端视图是保真视图，
 *    策展（单行预览/折叠）属于组件层。
 */

/** 终端行类型 —— 与引擎 IStreamActivityKind 对齐。`user_input`（2026-09-08
 *  可操作终端）是插话回写行：label = 消息全文。 */
export type TerminalLineKind =
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'status'
  | 'log'
  | 'error'
  | 'user_input'

/** 终端里的一行过程事件。 */
export interface TerminalLine {
  kind: TerminalLineKind
  label: string
  detail?: string
  at?: string
}

/** 终端里的一个节点段（section）。 */
export interface TerminalSection {
  id: string
  title: string
  status: string
  durationMs?: number | null
  tokensBadge: string | null
  nodeType?: string | null
  /** 提示行（$ 前缀）：`$ claude · model-x` / `$ llm` / `$ start` … */
  command: string
  lines: TerminalLine[]
  /** 节点产出正文（终态全文 / running partial），无正文为空串。 */
  output: string
  /** 无正文时的裸 JSON 产出（iteration/controller 等节点），终端兜底显示。 */
  rawJson: string
  /** 行数据来源：events=全量日志（2026-09-06 起）；activity=旧运行降级
   *  （摘要级）；none=无过程数据。终端视图据此提示旧运行。 */
  lineSource: 'events' | 'activity' | 'none'
  error: string | null
  /** 产出是「正文」而非裸 JSON（决定正文直出 vs 原始 JSON 折叠）。 */
  hasText: boolean
}

/** span 行的最小读取面（node-spans 端点 camelCase 形状）。 */
export interface TerminalSpanRow {
  nodeId?: string
  node_id?: string
  nodeLabel?: string | null
  nodeType?: string | null
  status?: string | null
  error?: string | null
  durationMs?: number | null
  tokens?: unknown
  input?: Record<string, unknown> | string | null
  output?: Record<string, unknown> | string | null
}

const LINE_KINDS: readonly TerminalLineKind[] = [
  'thinking',
  'tool',
  'tool_result',
  'status',
  'log',
  'error',
  'user_input',
]

/** 宽容解析 output.events / output.activity —— 形状不符返回空数组。
 *  返回 [lines, 来源]：events 优先（全量），否则降级 activity 环（摘要级）。 */
function spanLines(payload: TerminalSpanRow['output']): {
  lines: TerminalLine[]
  source: 'events' | 'activity' | 'none'
} {
  if (!payload || typeof payload !== 'object') return { lines: [], source: 'none' }
  const obj = payload as Record<string, unknown>
  const preferEvents = Array.isArray(obj.events) && obj.events.length > 0
  const source = preferEvents ? obj.events : obj.activity
  const kindOfSource: 'events' | 'activity' = preferEvents ? 'events' : 'activity'
  if (!Array.isArray(source)) return { lines: [], source: 'none' }
  const lines: TerminalLine[] = []
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const kind = e.kind
    if (typeof kind !== 'string' || !LINE_KINDS.includes(kind as TerminalLineKind)) continue
    const label = typeof e.label === 'string' ? e.label : ''
    if (!label && typeof e.detail !== 'string') continue
    const line: TerminalLine = { kind: kind as TerminalLineKind, label }
    if (typeof e.detail === 'string' && e.detail) line.detail = e.detail
    // activity 环旧形状：detail 缺席但 summary 在（策展摘要级）
    else if (typeof e.summary === 'string' && e.summary) line.detail = e.summary
    if (typeof e.at === 'string') line.at = e.at
    lines.push(line)
  }
  return { lines, source: lines.length > 0 ? kindOfSource : 'none' }
}

/** 正文提取：text/content 直出；DirectReply 的字符串化 JSON 二次解包。 */
export function extractOutputText(payload: TerminalSpanRow['output']): string | null {
  if (payload == null) return null
  if (typeof payload === 'string') return payload || null
  const obj = payload as Record<string, unknown>
  let textField =
    typeof obj.text === 'string' && obj.text
      ? obj.text
      : typeof obj.content === 'string' && obj.content
        ? obj.content
        : null
  if (textField && textField.trimStart().startsWith('{')) {
    try {
      const inner = JSON.parse(textField) as Record<string, unknown>
      if (typeof inner.text === 'string' && inner.text) textField = inner.text
      else if (typeof inner.content === 'string' && inner.content) textField = inner.content
    } catch {
      /* 保持原样 */
    }
  }
  return textField || null
}

/** tokens 载荷 → 紧凑徽章（↑输入 ↓输出），无用量返回 null。 */
export function formatTokensBadge(tokens: unknown): string | null {
  if (!tokens || typeof tokens !== 'object') return null
  const u = tokens as { inputTokens?: number; outputTokens?: number }
  if (u.inputTokens == null && u.outputTokens == null) return null
  const fmt = (n?: number): string =>
    n == null ? '0' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  return `↑${fmt(u.inputTokens)} ↓${fmt(u.outputTokens)}`
}

/** 提示行（$ 前缀）：节点类型 × input.model 组合成「这条 CLI 在跑什么」。 */
function commandOf(nodeType: string | null | undefined, input: TerminalSpanRow['input']): string {
  const model =
    input && typeof input === 'object' && typeof input.model === 'string' && input.model
      ? input.model
      : ''
  const base =
    nodeType === 'platformAgent'
      ? 'agent'
      : nodeType === 'llm'
        ? 'llm'
        : nodeType === 'directReply'
          ? 'reply'
          : nodeType === 'customFunction'
            ? 'fn'
            : nodeType === 'http'
              ? 'http'
              : nodeType === 'humanInput'
                ? 'input'
                : nodeType || 'node'
  return `$ ${base}${model ? ` · ${model}` : ''}`
}

/** span 行 → 终端段。 */
export function spanToTerminalSection(sp: TerminalSpanRow): TerminalSection {
  const text = extractOutputText(sp.output)
  const { lines, source: lineSource } = spanLines(sp.output)
  const rawJson =
    text == null &&
    sp.output &&
    typeof sp.output === 'object' &&
    Object.keys(sp.output).length > 0
      ? JSON.stringify(sp.output, null, 1)
      : ''
  return {
    id: sp.nodeId ?? sp.node_id ?? '?',
    title: sp.nodeLabel || sp.nodeId || sp.node_id || '?',
    status: sp.status ?? '',
    durationMs: sp.durationMs ?? null,
    tokensBadge: formatTokensBadge(sp.tokens),
    nodeType: sp.nodeType ?? null,
    command: commandOf(sp.nodeType, sp.input),
    lines,
    lineSource,
    output: text ?? '',
    rawJson,
    error: sp.error ?? null,
    hasText: text != null,
  }
}

/** section → 可复制的过程实录文本（段头 + 提示行 + 事件行 + 正文）。 */
export function sectionTranscript(s: TerminalSection): string {
  const parts: string[] = [`── ${s.title} · ${s.status} ──`, s.command]
  for (const line of s.lines) {
    const icon =
      line.kind === 'thinking'
        ? '💭'
        : line.kind === 'tool'
          ? '🔧'
          : line.kind === 'tool_result'
            ? '↳'
            : line.kind === 'error'
              ? '✗'
              : line.kind === 'user_input'
                ? '❯'
                : '·'
    parts.push(`${icon} ${line.label}${line.detail ? `\n${line.detail}` : ''}`)
  }
  if (s.error) parts.push(`✗ ${s.error}`)
  if (s.output) parts.push(s.output)
  return parts.join('\n')
}
