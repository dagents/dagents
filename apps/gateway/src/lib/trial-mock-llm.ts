/**
 * trial-mock-llm —— 画布试运行的代码级 fake llmClient（R10，design-sharp
 * §3.4-①；内核自 e2e :4010 mock server（server.mjs:36-95/98-121/124-164）
 * 源码级移植为纯 TS——谓词集逐字段对齐，两份实现的行为等价由
 * trial-mock-llm.test.ts 钉住）。
 *
 * 部署形态（PRD R10.1 定稿）：不做 llm_providers 行、不起独立进程——
 * `assembleWorkflowEngine({ llmClientOverride: createTrialLlmClient(...) })`
 * 整体换装。e2e 栈不迁移（:4010 server 继续用，不共享运行时进程）。
 *
 * 诚实边界（ADR docs/superpowers/specs/2026-10-07-pending-state-in-memory-red-line.md
 * §3）：调用记录存进程内 registry（run 终态后 10 分钟清理、重启即丢）——
 * 持久层是 spans（span.input 已落库），trial-calls 端点 404 时证据面板
 * 回退 spans 投影。假 usage 会进 span tokens 但不入 usage_events 账单
 * （试运行路由不调 recordUsageEvent，§3.5 隔离）。
 */
import type {
  TrialMockCall,
  TrialMockRespond,
  TrialMockRule,
  TrialMockScript,
  TrialMockScriptSet,
} from '@dagents/contracts'
import type { IChatMessage, IStreamDelta, IToolCall, ITokenUsage } from '@dagents/workflow'
import { declareCounter } from './metrics.js'

// NFR-6 可观测：试运行量与 mock 命中率。
const trialRunsTotal = declareCounter('dagents_trial_runs_total', 'Canvas trial runs started (R10)')
const trialMockCallsTotal = declareCounter(
  'dagents_trial_mock_calls_total',
  'Fake llmClient calls during canvas trial runs, by rule match result',
  ['matched'],
)

export function recordTrialRunStarted(): void {
  trialRunsTotal.inc()
}

// ── 谓词匹配（server.mjs:36-73 逐字段移植；未知谓词一律不命中） ────────────

interface ChatCompletionLike {
  model?: string
  messages?: Array<{ role?: string; content?: unknown }>
}

export function ruleMatches(
  match: Record<string, unknown> | undefined,
  body: ChatCompletionLike,
): boolean {
  if (!match) return true
  const messages = Array.isArray(body.messages) ? body.messages : []
  const contentOf = (role: string): string[] =>
    messages
      .filter((m) => m && m.role === role && typeof m.content === 'string')
      .map((m) => m.content as string)
  const hasToolResult = messages.some((m) => m && m.role === 'tool')

  for (const [key, want] of Object.entries(match)) {
    switch (key) {
      case 'systemContains':
        if (!contentOf('system').some((c) => c.includes(String(want)))) return false
        break
      case 'userContains':
        if (!contentOf('user').some((c) => c.includes(String(want)))) return false
        break
      case 'assistantContains':
        if (!contentOf('assistant').some((c) => c.includes(String(want)))) return false
        break
      case 'toolResultContains':
        if (!contentOf('tool').some((c) => c.includes(String(want)))) return false
        break
      case 'messagesContain':
        if (
          !messages.some(
            (m) => typeof m?.content === 'string' && (m.content as string).includes(String(want)),
          )
        )
          return false
        break
      case 'hasToolResult':
        if (hasToolResult !== Boolean(want)) return false
        break
      case 'modelIs':
        if (body.model !== want) return false
        break
      default:
        return false // 未知谓词一律不命中，脚本写错时快速失败
    }
  }
  return true
}

export interface ResolvedMockResponse {
  label: string
  mode: NonNullable<TrialMockRespond['mode']>
  text: string
  toolCalls?: unknown[]
  usage?: unknown
  delayMs: number
  streamChunkSize?: number
  streamIntervalMs?: number
}

export function resolveMockResponse(
  script: TrialMockScript,
  body: ChatCompletionLike,
): ResolvedMockResponse {
  const rule: TrialMockRule | undefined = script.rules.find((r) => ruleMatches(r.match, body))
  const source: TrialMockRespond = rule?.respond ?? script.fallback ?? { text: 'mock:unmatched' }
  const label = rule?.label ?? (rule ? `rule[${script.rules.indexOf(rule)}]` : 'fallback')
  // mode 扩展：toolLoop = 无视消息内容永远要工具（测 maxIterations 封顶）
  if (source.mode === 'toolLoop') {
    return { label, mode: 'ok', text: '', toolCalls: source.toolCalls ?? [], delayMs: 0 }
  }
  const delayMs = Number(source.delayMs ?? 0)
  return {
    label,
    mode: source.mode ?? 'ok',
    text: source.text ?? '',
    toolCalls: source.toolCalls,
    usage: source.usage,
    delayMs: Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0,
    streamChunkSize: source.streamChunkSize,
    streamIntervalMs: source.streamIntervalMs,
  }
}

const DEFAULT_USAGE: ITokenUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** OpenAI 形状 tool_calls → 引擎 IToolCall（server.mjs completionBody 同映射）。 */
function toToolCalls(raw: unknown[] | undefined): IToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined
  return raw.map((tc, i) => {
    const r = tc as { id?: string; function?: { name?: string; arguments?: string } }
    return {
      id: r.id ?? `call_mock_${Date.now()}_${i}`,
      function: { name: r.function?.name ?? 'unknown', arguments: r.function?.arguments ?? '{}' },
    }
  })
}

// ── 进程内 trial-registry（调用记录 + TTL 清理） ───────────────────────────

const TRIAL_CALLS_TTL_MS = 10 * 60 * 1000

/** runId → 调用记录（有序）。进程内 Map——重启即丢（诚实边界见文件头）。 */
const trialCallsByRun = new Map<string, { calls: TrialMockCall[]; seq: number }>()
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function recordTrialMockCall(runId: string, call: Omit<TrialMockCall, 'seq'>): void {
  const entry = trialCallsByRun.get(runId) ?? { calls: [], seq: 0 }
  entry.seq += 1
  entry.calls.push({ seq: entry.seq, ...call })
  trialCallsByRun.set(runId, entry)
}

export function getTrialCalls(runId: string): TrialMockCall[] | null {
  return trialCallsByRun.get(runId)?.calls ?? null
}

/** run 终态后安排清理（10 分钟，对齐 shell 孤儿回收取舍；幂等）。 */
export function scheduleTrialCallsCleanup(runId: string): void {
  const prev = cleanupTimers.get(runId)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    trialCallsByRun.delete(runId)
    cleanupTimers.delete(runId)
  }, TRIAL_CALLS_TTL_MS)
  // 不阻止进程退出（gateway 停机不被试运行记录卡住）
  ;(timer as { unref?: () => void }).unref?.()
  cleanupTimers.set(runId, timer)
}

// ── 未解析占位符复扫（与 llm.node.ts 运行时同启发式——AC-R10-7 动态层） ──

export function scanUnresolvedPlaceholders(messages: IChatMessage[]): string[] {
  const found: string[] = []
  for (const m of messages) {
    if (typeof m.content !== 'string') continue
    for (const mt of m.content.matchAll(/\{\{([^}]+)\}\}/g)) {
      found.push(mt[1].trim())
    }
  }
  return [...new Set(found)].slice(0, 20)
}

// ── fake client 本体 ───────────────────────────────────────────────────────

export interface TrialLlmClientDeps {
  runId: string
  /** 单脚本或节点级编排（byNode 按 params.nodeId 选，缺省 default）。 */
  script: TrialMockScript | TrialMockScriptSet
}

interface ChatParams {
  model: string
  messages: IChatMessage[]
  temperature?: number
  signal?: AbortSignal
  nodeId?: string
  onDelta?: (chunk: IStreamDelta) => void
}

function pickScript(
  script: TrialMockScript | TrialMockScriptSet,
  nodeId?: string,
): TrialMockScript {
  if ('rules' in script || 'fallback' in script) return script as TrialMockScript
  const set = script as TrialMockScriptSet
  if (nodeId && set.byNode?.[nodeId]) return set.byNode[nodeId]
  return set.default ?? { rules: [] }
}

export function createTrialLlmClient(deps: TrialLlmClientDeps): {
  chat(params: ChatParams): Promise<{ text: string; tool_calls?: IToolCall[]; usage?: ITokenUsage }>
  chatStream(params: ChatParams): AsyncIterable<{ delta?: string; usage?: ITokenUsage }>
} {
  const apply = (
    params: ChatParams,
  ): { resolved: ResolvedMockResponse; body: ChatCompletionLike } => {
    const script = pickScript(deps.script, params.nodeId)
    const body: ChatCompletionLike = { model: params.model, messages: params.messages }
    return { resolved: resolveMockResponse(script, body), body }
  }

  const record = (params: ChatParams, resolved: ResolvedMockResponse): void => {
    trialMockCallsTotal.inc(1, { matched: resolved.label === 'fallback' ? 'miss' : 'hit' })
    recordTrialMockCall(deps.runId, {
      nodeId: params.nodeId,
      model: params.model,
      messages: params.messages,
      matchedRule: resolved.label,
      unresolvedPlaceholders: scanUnresolvedPlaceholders(params.messages),
      ts: new Date().toISOString(),
    })
  }

  /** 错误/边界注入（server.mjs 的 HTTP 形态 → 代码级等价抛错）。 */
  const injectOrFail = (resolved: ResolvedMockResponse): void => {
    if (resolved.mode === 'error') throw new Error('mock: injected error')
    if (resolved.mode === 'malformed')
      throw new Error('mock: 响应体不是合法 JSON（malformed 注入）')
  }

  return {
    async chat(params) {
      const { resolved } = apply(params)
      record(params, resolved)
      if (resolved.delayMs > 0) await sleep(resolved.delayMs)
      injectOrFail(resolved)
      const text = resolved.mode === 'empty' ? '' : resolved.text
      const toolCalls = toToolCalls(resolved.toolCalls)
      return {
        text,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        usage: (resolved.usage as ITokenUsage | undefined) ?? DEFAULT_USAGE,
      }
    },
    async *chatStream(params) {
      const { resolved } = apply(params)
      record(params, resolved)
      if (resolved.delayMs > 0) await sleep(resolved.delayMs)
      injectOrFail(resolved)
      const text = resolved.mode === 'empty' ? '' : resolved.text
      const chunkSize = Math.max(1, Number(resolved.streamChunkSize ?? 8))
      const intervalMs = Math.max(0, Number(resolved.streamIntervalMs ?? 10))
      const chunks: string[] = []
      for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize))
      if (chunks.length === 0) chunks.push('')
      let first = true
      for (const chunk of chunks) {
        if (!first && intervalMs > 0) await sleep(intervalMs)
        first = false
        yield { delta: chunk }
      }
      yield { usage: (resolved.usage as ITokenUsage | undefined) ?? DEFAULT_USAGE }
    },
  }
}
