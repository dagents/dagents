/**
 * LLM client + agent fetcher + tool registry + history retriever for workflow
 * execution.
 *
 * The DagExecutor needs an `llmClient` (for LLM/Agent/PlatformAgent nodes), an
 * `agentFetcher` (for PlatformAgentNode), a `toolRegistry` (built-in tools +
 * anything Tool nodes register at runtime) and a `historyRetriever` (for the
 * Retriever node). All are provided by the gateway because they need DB or
 * network access — the workflow package stays storage-free.
 */

import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { createBackend } from '@dagents/agent-adapters'
import type { AgentEvent, AgentType } from '@dagents/contracts'
import { decryptSecret } from '../crypto.js'
import { composeSystemPrompt } from '../skill-injection.js'
import {
  DagExecutor,
  NodeRegistry,
  allNodes,
  type IExecutionContext,
  type PlatformAgentConfig,
  type ITokenUsage,
  type IToolSchema,
  type IToolCall,
  type IAgentTool,
  type IChatMessage,
  type IChatStreamChunk,
  type IExecutedNode,
} from '@dagents/workflow'

const log = createLogger({ svc: 'gateway:workflow-clients' })

/** LLM provider row from the `llm_providers` table. */
interface LlmProviderRow {
  id: string
  base_url: string
  api_key: string
  default_model: string
  provider_type: string
}

/** Cached LLM provider — fetched once per run, reused across nodes. */
let cachedProvider: LlmProviderRow | null = null
let providerFetchPromise: Promise<LlmProviderRow | null> | null = null

/**
 * Fetch the first active LLM provider. Cached after first call within a
 * process lifetime; use `resetProviderCache()` before each run to force
 * a fresh read (provider config may have changed).
 */
async function getActiveProvider(): Promise<LlmProviderRow | null> {
  if (cachedProvider) return cachedProvider
  if (providerFetchPromise) return providerFetchPromise

  providerFetchPromise = (async () => {
    try {
      const { records } = await runQuery<LlmProviderRow>(
        `SELECT id, base_url, api_key, default_model, provider_type
           FROM llm_providers
           WHERE status = 'active'
           ORDER BY created_at ASC
           LIMIT 1`,
        [],
      )
      cachedProvider = records[0] ?? null
      return cachedProvider
    } catch (err) {
      log.error('failed to fetch LLM provider', { error: String(err) })
      return null
    } finally {
      providerFetchPromise = null
    }
  })()

  return providerFetchPromise
}

/** CLI-backed chat params (mirrors the workflow engine's llmClient seam). */
export interface CliChatParams {
  model: string
  messages: { role: string; content: string }[]
  temperature?: number
  tools?: IToolSchema[]
  /** Cancellation signal (spec D3): aborts the HTTP fetch / kills the CLI child. */
  signal?: AbortSignal
  /** 增量产出回调（2026-08-30 流式展示）：text 增量 + thinking/工具活动。 */
  onDelta?: (chunk: import('@dagents/workflow').IStreamDelta) => void
}

/**
 * Collapse engine chat messages into the two fields a CLI agent accepts:
 * system messages merge into the system prompt, the rest become a
 * role-prefixed conversation. Pure — unit-tested.
 */
export function buildCliMessages(messages: { role: string; content: string }[]): {
  systemPrompt: string | undefined
  prompt: string
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim()
  const rest = messages.filter((m) => m.role !== 'system')
  const prompt = rest.length
    ? rest.map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content}`).join('\n\n')
    : '(no input)'
  return { systemPrompt: system || undefined, prompt }
}

/**
 * 工作流 CLI 调用不设墙钟上限 —— Agent 自主长跑是常态（2026-08-27 产品
 * 决策：真实复跑中 3/4 并行 Agent 在 180s 墙被截断成「部分文本 + done」
 * 的假成功）。唯一保留的清理机制是静默看门狗：逐行输出即重置，活跃
 * 干活永不触发，真挂死 N 分钟后 SIGTERM→SIGKILL。显式取消走 signal。
 * 默认与 inline 执行路径（INLINE_INACTIVITY_TIMEOUT_MS）对齐。
 */
export const CLI_INACTIVITY_TIMEOUT_MS = Number(
  process.env.WORKFLOW_CLI_INACTIVITY_TIMEOUT_MS ?? 300_000,
)

/**
 * Timeout (ms) for HTTP LLM calls: non-stream `chat` gets it as a total
 * wall-clock budget; `chatStream` uses it as first-byte + inter-chunk idle
 * watchdog so long legitimate streams are never cut mid-flight, only hung
 * upstreams are. Env-tunable.
 */
export const LLM_HTTP_TIMEOUT_MS = Number(process.env.LLM_HTTP_TIMEOUT_MS ?? 120_000)

/**
 * CLI-backed llmClient — the CLI-first baseline for workflow execution.
 *
 * First-class-CLI principle: local CLI agents (claude by default) are the
 * zero-config execution engine; an HTTP provider is optional acceleration.
 * Spawns the CLI with the conversation as one prompt and returns the final
 * text. tool_calls are never returned — the PlatformAgent tool loop
 * degenerates to a single call (the CLI brings its own tools anyway).
 */
/**
 * 工具调用活动的单行标签（旁观端活动流用）：`工具名(参数摘要)`。
 * 参数 JSON 截 60 字 —— 是「它在干什么」的线索，不是完整审计。
 */
function toolLabel(evt: Extract<AgentEvent, { type: 'tool-use' }>): string {
  let args = ''
  try {
    args = JSON.stringify(evt.input ?? {})
  } catch {
    args = String(evt.input ?? {})
  }
  if (args.length > 60) args = args.slice(0, 60) + '…'
  return `${evt.tool || 'tool'}(${args})`
}

/**
 * 文本档 CLI 旗标（PRD FR-03 / 决议 D4）：纯 LLM 调用（未声明 tools）时
 * 从模型工具集整体移除内建工具。背景：适配器默认 bypassPermissions，
 * 零 Provider 时「纯 LLM 节点」实际是带全套工具的真 agent —— 实测
 * 「代码审查链」把「审查这段贴入代码」漂移成在项目仓库里 rg/git 全仓
 * 调查（318s / ~9 万 tokens，结论「该函数不在仓库中」）。
 * `--disallowedTools` 直接摘除工具（与 permission mode 正交）；
 * PlatformAgent 工具循环声明了 tools，不受影响。
 */
const CLI_TEXT_MODE_ARGS = [
  '--disallowedTools',
  'Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,TodoRead,BashOutput,KillShell',
]

export function createCliLlmClient(kind: AgentType = 'claude', cliCwd?: string) {
  /** 共享：为本次执行创建 backend session（chat 与 chatStream 同款启动）。 */
  const startSession = (params: CliChatParams) => {
    const { systemPrompt, prompt } = buildCliMessages(params.messages)
    const agentToolsDeclared = Array.isArray(params.tools) && params.tools.length > 0
    // 文本档仅对 claude 生效（--disallowedTools 是 claude CLI 旗标；其他
    // 适配器无对应机制，保持原行为 —— 与 D4「非 claude 标注未真机」一致）
    const textModeArgs = kind === 'claude' && !agentToolsDeclared ? CLI_TEXT_MODE_ARGS : undefined
    const backend = createBackend(kind, { executablePath: '', logger: log })
    return backend.execute(prompt, {
      systemPrompt,
      inactivityTimeoutMs: CLI_INACTIVITY_TIMEOUT_MS,
      signal: params.signal,
      // 工作目录 = 项目目录：Agent/LLM 节点的 CLI 在选定项目里干活
      //（读写文件、跑命令都基于它）。缺省回落 gateway 进程 cwd。
      cwd: cliCwd,
      // 文本档：无工具声明的调用禁用全部内建工具（见 CLI_TEXT_MODE_ARGS）
      ...(textModeArgs ? { extraArgs: textModeArgs } : {}),
    })
  }
  return {
    async chat(params: CliChatParams): Promise<{ text: string; usage?: ITokenUsage }> {
      const session = startSession(params)
      let text = ''
      for await (const evt of session.events as AsyncIterable<AgentEvent>) {
        // text 事件既是最终正文也是增量 —— 有 onDelta 就逐事件转发
        //（AgentSession.events 与 result 解耦，天生支持边跑边吐）
        if (evt.type === 'text') {
          text += evt.content
          params.onDelta?.({ type: 'text', text: evt.content })
        } else if (evt.type === 'thinking') {
          params.onDelta?.({ type: 'activity', kind: 'thinking', label: evt.content })
        } else if (evt.type === 'tool-use') {
          params.onDelta?.({ type: 'activity', kind: 'tool', label: toolLabel(evt) })
        }
      }
      const result = await session.result
      if (result.status !== 'completed') {
        // 任何非完成状态（timeout/aborted/cancelled/failed）都如实抛错：
        // 此前只检查 failed，被看门狗清理的运行带着部分文本落回「成功」，
        // 表现为 span done + 空/截断 content（真实复跑的假成功来源）。
        // usage 附着到错误对象 —— 引擎失败路径据此把已产生 tokens 落 span。
        const err = new Error(
          `CLI agent 未完成（${result.status}）：${result.error ?? '未知错误'}`,
        )
        const models = Object.keys(result.usage ?? {})
        if (models.length > 0) {
          let usageIn = 0
          let usageOut = 0
          for (const m of models) {
            const u = result.usage![m] as { inputTokens?: number; outputTokens?: number } | undefined
            usageIn += u?.inputTokens ?? 0
            usageOut += u?.outputTokens ?? 0
          }
          const withUsage = err as Error & { usage?: ITokenUsage }
          withUsage.usage = {
            prompt_tokens: usageIn,
            completion_tokens: usageOut,
            total_tokens: usageIn + usageOut,
            inputTokens: usageIn,
            outputTokens: usageOut,
          }
        }
        throw err
      }
      // 聚合各模型 usage（claude stream-json 事件携带）—— 结果面板的
      // token 徽章 / runs 用量聚合都依赖它；此前只返回 text 导致恒空。
      let usage: ITokenUsage | undefined
      const models = Object.keys(result.usage ?? {})
      if (models.length > 0) {
        let input = 0
        let output = 0
        for (const m of models) {
          const u = result.usage![m] as { inputTokens?: number; outputTokens?: number } | undefined
          input += u?.inputTokens ?? 0
          output += u?.outputTokens ?? 0
        }
        // 双命名（ITokenUsage 是 prompt_tokens 命名 + 开放索引；结果面板
        // 的 tokensBadge 读 inputTokens/outputTokens）。此前 completion_tokens
        // 误写成 input（笔误），输出侧用量被夸大。
        usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, inputTokens: input, outputTokens: output }
      }
      return { text: text || result.output || '', usage }
    },
    /**
     * CLI 真流式（2026-08-30）：逐消费 session.events，每个 text 事件即刻
     * yield —— 不再等 result 后一次性吐全文。usage/error 聚合与 chat
     * 同款（result 兜底校验）。
     */
    async *chatStream(params: CliChatParams): AsyncGenerator<IChatStreamChunk> {
      const session = startSession(params)
      for await (const evt of session.events as AsyncIterable<AgentEvent>) {
        if (evt.type === 'text') {
          yield { delta: evt.content }
          params.onDelta?.({ type: 'text', text: evt.content })
        } else if (evt.type === 'thinking') {
          params.onDelta?.({ type: 'activity', kind: 'thinking', label: evt.content })
        } else if (evt.type === 'tool-use') {
          params.onDelta?.({ type: 'activity', kind: 'tool', label: toolLabel(evt) })
        }
      }
      const result = await session.result
      if (result.status !== 'completed') {
        throw new Error(`CLI agent 未完成（${result.status}）：${result.error ?? '未知错误'}`)
      }
      let usage: ITokenUsage | undefined
      const models = Object.keys(result.usage ?? {})
      if (models.length > 0) {
        let input = 0
        let output = 0
        for (const m of models) {
          const u = result.usage![m] as { inputTokens?: number; outputTokens?: number } | undefined
          input += u?.inputTokens ?? 0
          output += u?.outputTokens ?? 0
        }
        usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, inputTokens: input, outputTokens: output }
      }
      if (usage) yield { usage }
    },
  }
}

/**
 * Default llmClient for workflow execution. CLI-first: an explicitly
 * configured HTTP provider wins (opt-in acceleration), otherwise every
 * LLM/Agent node runs on the local CLI — workflows work with zero setup,
 * same as chat.
 *
 * `chatStream` streams real deltas both ways: provider path parses SSE
 * frames; CLI path consumes AgentSession.events (2026-08-30 —— 此前 CLI
 * 退化为 result 后一次性吐全文，画布/详情旁观看不到生成过程).
 */
export function createDefaultLlmClient(kind: AgentType = 'claude', opts: { cwd?: string } = {}) {
  const http = createLlmClient()
  const cli = createCliLlmClient(kind, opts.cwd)
  return {
    async chat(params: CliChatParams): Promise<{ text: string; tool_calls?: IToolCall[]; usage?: ITokenUsage }> {
      const provider = await getActiveProvider()
      if (provider) return http.chat(params)
      return cli.chat(params)
    },
    async *chatStream(params: CliChatParams): AsyncGenerator<IChatStreamChunk> {
      const provider = await getActiveProvider()
      if (provider) {
        yield* http.chatStream(params)
        return
      }
      yield* cli.chatStream(params)
    },
  }
}

/** Reset the provider cache — call before each workflow run. */
export function resetProviderCache(): void {
  cachedProvider = null
  providerFetchPromise = null
}

/**
 * Decode the API key stored in llm_providers. Keys are stored either
 * AES-256-GCM encrypted (`enc:v1:…`, when ENCRYPTION_KEY is set) or legacy
 * Base64 — `decryptSecret` handles both. (This used to base64-decode the
 * ciphertext blob directly, which garbled the Bearer token and 401'd every
 * workflow LLM call whenever encryption was configured.)
 */
function decodeApiKey(encoded: string): string {
  return decryptSecret(encoded)
}

/**
 * Create an llmClient that calls an OpenAI-compatible /v1/chat/completions
 * endpoint using credentials from the `llm_providers` table.
 *
 * `chat` returns `{ text, usage }` where `usage` is the token usage reported
 * by the provider; `chatStream` yields incremental deltas by requesting
 * `stream: true` and parsing the provider's SSE frames. If no provider is
 * configured, both throw — the calling node catches and marks itself failed.
 */
/**
 * HTTP LLM client（具体返回类型）：chatStream 恒有实现（SSE 解析），因此
 * 这里声明为必选 —— 必选成员可赋值给 IExecutionContext['llmClient'] 的
 * 可选 chatStream，同时 createDefaultLlmClient 的转发调用不需要非空断言
 * （修复 main 上遗留的 TS2722：接口把 chatStream 标成可选，导致
 * `http.chatStream(params)` 报「possibly undefined」）。
 */
interface HttpLlmClient {
  chat(params: Parameters<NonNullable<IExecutionContext['llmClient']>['chat']>[0]): ReturnType<NonNullable<IExecutionContext['llmClient']>['chat']>
  chatStream(params: {
    model: string
    messages: IChatMessage[]
    temperature?: number
    signal?: AbortSignal
  }): AsyncIterable<IChatStreamChunk>
}

export function createLlmClient(
  override: { providerId?: string; model?: string } = {},
): HttpLlmClient {
  return {
    async chat(params) {
      const { url, headers, body } = await prepareRequest(params, false, override)
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: params.signal
          ? AbortSignal.any([AbortSignal.timeout(LLM_HTTP_TIMEOUT_MS), params.signal])
          : AbortSignal.timeout(LLM_HTTP_TIMEOUT_MS),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 500)}`)
      }

      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{
              id: string
              type: 'function'
              function: { name: string; arguments: string }
            }>
          }
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
        }
      }

      const message = json.choices?.[0]?.message
      const text = message?.content ?? ''
      // Normalise tool calls: present only when the model actually requested
      // one, so callers can treat a missing `tool_calls` as "final answer".
      const rawToolCalls = message?.tool_calls
      const tool_calls: IToolCall[] | undefined = Array.isArray(rawToolCalls) && rawToolCalls.length > 0
        ? rawToolCalls.map((tc) => ({ id: tc.id, function: tc.function }))
        : undefined
      const usage: ITokenUsage | undefined = json.usage
        ? {
            prompt_tokens: json.usage.prompt_tokens,
            completion_tokens: json.usage.completion_tokens,
            total_tokens: json.usage.total_tokens,
          }
        : undefined

      return { text, tool_calls, usage }
    },

    async *chatStream(params): AsyncGenerator<IChatStreamChunk> {
      const { url, headers, body } = await prepareRequest(params, true, override)
      // Idle watchdog: fires when no byte arrives within the budget — covers
      // both a hung upstream (no first byte) and a stream stalled mid-flight.
      // Every chunk read re-arms the timer, so long healthy streams survive.
      const controller = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(
          () => controller.abort(new Error(`LLM stream idle for over ${LLM_HTTP_TIMEOUT_MS}ms`)),
          LLM_HTTP_TIMEOUT_MS,
        )
      }
      armIdle() // covers time-to-headers — a hung upstream never sends headers
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: params.signal
            ? AbortSignal.any([controller.signal, params.signal])
            : controller.signal,
        })
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 500)}`)
      }
      if (!res.body) {
        throw new Error('LLM API returned no stream body')
      }

      // Parse OpenAI-compatible SSE frames:
      //   data: {"choices":[{"delta":{"content":"..."}}], "usage": {...}}
      //   data: [DONE]
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      armIdle() // headers→first-chunk gap
      try {
        for (;;) {
          const { done, value } = await reader.read()
          armIdle() // healthy traffic keeps re-arming; silence trips the abort
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let sep: number
          while ((sep = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, sep).trim()
            buffer = buffer.slice(sep + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') return

            try {
              const frame = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string | null } }>
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
              }
              const delta = frame.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta.length > 0) {
                yield { delta }
              }
              if (frame.usage) {
                yield {
                  usage: {
                    prompt_tokens: frame.usage.prompt_tokens,
                    completion_tokens: frame.usage.completion_tokens,
                    total_tokens: frame.usage.total_tokens,
                  },
                }
              }
            } catch {
              // skip malformed frames — providers occasionally emit keepalives
            }
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        reader.releaseLock()
      }
    },
  }
}

/** Resolve the provider and build the request parts for a chat call. */
async function prepareRequest(
  params: {
    model: string
    messages: unknown
    temperature?: number
    tools?: IToolSchema[]
  },
  stream: boolean,
  override: { providerId?: string; model?: string } = {},
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  // Explicit provider override (canvas generator picking `providerId::model`):
  // bypass the active-provider cache and read that row directly.
  let provider: LlmProviderRow | null
  if (override.providerId) {
    const { records } = await runQuery<LlmProviderRow>(
      `SELECT id, base_url, api_key, default_model, provider_type
         FROM llm_providers
        WHERE id = $1`,
      [override.providerId],
    )
    provider = records[0] ?? null
  } else {
    provider = await getActiveProvider()
  }
  if (!provider) {
    throw new Error(
      'No active LLM provider configured. Add one in the LLM Providers settings.',
    )
  }

  const model = override.model || params.model || provider.default_model
  if (!model) {
    throw new Error('No model specified and provider has no default model')
  }

  const apiKey = decodeApiKey(provider.api_key)
  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const url = `${baseUrl}/v1/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    stream,
  }
  if (params.temperature != null) {
    body.temperature = params.temperature
  }
  // Forward function tools so the model can request tool calls. The
  // OpenAI-compatible endpoint returns `choices[0].message.tool_calls`
  // when the model decides to call a tool instead of replying directly.
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools
  }
  if (stream) {
    // Ask the provider to include token usage on the final streamed frame.
    body.stream_options = { include_usage: true }
  }

  return {
    url,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }
}

/**
 * Create an agentFetcher that reads agent config from the `agents` table.
 * Used by PlatformAgentNode to resolve an agentId to its instructions/model.
 *
 * `skills` 在网关侧预先解析为 SKILL.md 正文并组装进 instructions（见
 * skill-injection.ts），因此传给节点的是空数组 —— 节点层的技能名清单
 * 只作为未预解析 fetcher 的兜底，避免同一技能被声明两遍。
 */
export function createAgentFetcher(): NonNullable<IExecutionContext['agentFetcher']> {
  return async (agentId: string): Promise<PlatformAgentConfig | null> => {
    try {
      const { records } = await runQuery<{
        id: string
        name: string
        instructions: string
        model: string
        kind: string
        skills: unknown
      }>(
        `SELECT id, name, instructions, model, kind, skills
           FROM agents
           WHERE id = $1`,
        [agentId],
      )
      const row = records[0]
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        instructions: composeSystemPrompt(row.instructions, row.skills) ?? '',
        model: row.model,
        kind: row.kind,
        skills: [],
      }
    } catch (err) {
      log.error('agentFetcher query failed', { agentId, error: String(err) })
      return null
    }
  }
}

/** Cap HTTP tool responses so a huge payload can't blow up the LLM context. */
const HTTP_TOOL_MAX_RESPONSE = 32 * 1024
const HTTP_TOOL_TIMEOUT_MS = 15_000

/**
 * Built-in tools available to every workflow run — the base layer of the
 * executor's per-run tool registry (Tool nodes in the graph add more as they
 * execute). Deliberately small and safe: an HTTP caller and a clock.
 */
export function createBuiltInToolRegistry(): Record<string, IAgentTool> {
  const httpRequest: IAgentTool = {
    name: 'http_request',
    description:
      'Perform an HTTP request and return the response body (truncated). ' +
      'Use for APIs and web lookups; returns {"status": number, "body": string}.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to request' },
        method: { type: 'string', description: 'HTTP method (default GET)' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'object', description: 'JSON request body (POST/PUT/PATCH)' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) {
        return 'Error: url must be an absolute http(s) URL'
      }
      const method = String(args.method ?? 'GET').toUpperCase()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HTTP_TOOL_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            ...(isRecord(args.headers) ? args.headers : {}),
            ...(args.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
          signal: controller.signal,
        })
        const text = (await res.text()).slice(0, HTTP_TOOL_MAX_RESPONSE)
        return JSON.stringify({ status: res.status, body: text })
      } catch (err) {
        return `Error: http_request failed — ${err instanceof Error ? err.message : String(err)}`
      } finally {
        clearTimeout(timer)
      }
    },
  }

  const datetimeNow: IAgentTool = {
    name: 'datetime_now',
    description: 'Get the current date and time (ISO-8601, local timezone).',
    parameters: { type: 'object', properties: {} },
    handler: async () => new Date().toISOString(),
  }

  return { [httpRequest.name]: httpRequest, [datetimeNow.name]: datetimeNow }
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Create a historyRetriever for the Retriever node — keyword search over the
 * chat's persisted messages (newest first). Chat id comes from the execution
 * context at call time, so the retriever is created per run alongside the
 * other clients.
 */
export function createHistoryRetriever(
  chatId: string,
): NonNullable<IExecutionContext['historyRetriever']> {
  return async (query, topK) => {
    try {
      // Split the query into words and AND them with ILIKE — a cheap,
      // dependency-free keyword match. Words shorter than 2 chars are noise.
      const words = query
        .split(/\s+/)
        .map((w) => w.replace(/[%_]/g, ''))
        .filter((w) => w.length >= 2)
        .slice(0, 8)
      if (words.length === 0) return []

      const conditions = words.map((_, i) => `content ILIKE $${i + 2}`).join(' AND ')
      const { records } = await runQuery<{ role: string; content: string; created_at: Date }>(
        `SELECT role, content, created_at
           FROM chat_messages
          WHERE chat_id = $1::uuid
            AND ${conditions}
          ORDER BY created_at DESC
          LIMIT ${Math.max(1, Math.min(topK, 50))}`,
        [chatId, ...words.map((w) => `%${w}%`)],
      )
      return records.map((r) => ({
        role: r.role,
        content: r.content,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }))
    } catch (err) {
      log.error('historyRetriever query failed', { chatId, error: String(err) })
      return []
    }
  }
}

/** Max subflow nesting (flow → subflow → subsubflow); beyond this the node fails. */
const MAX_SUBFLOW_DEPTH = 3

const FLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shared run context a subflow inherits from its parent execution. */
export interface SubflowDeps {
  chatId: string
  runId: string
  llmClient: NonNullable<IExecutionContext['llmClient']>
  agentFetcher: NonNullable<IExecutionContext['agentFetcher']>
  toolRegistry: Record<string, IAgentTool>
  historyRetriever?: IExecutionContext['historyRetriever']
  humanInputResolver?: IExecutionContext['humanInputResolver']
  /** Receives the subflow's executed nodes so the parent run's span persistence can include them. */
  onExecutedNodes?: (nodes: IExecutedNode[]) => void
}

/**
 * Create the `flowExecutor` for ExecuteFlow nodes: loads the referenced
 * flow, runs it on a fresh DagExecutor with the parent run's clients, and
 * returns its final output. Subflows execute with `isLastNode: false` —
 * they never stream into the parent's token stream (avoids interleaved
 * partial replies); nested ExecuteFlow nodes keep working down to
 * MAX_SUBFLOW_DEPTH.
 */
export function createFlowExecutor(
  deps: SubflowDeps,
  depth = 0,
): NonNullable<IExecutionContext['flowExecutor']> {
  return async (flowId, input) => {
    if (depth >= MAX_SUBFLOW_DEPTH) {
      throw new Error(`ExecuteFlow: subflow nesting exceeds max depth (${MAX_SUBFLOW_DEPTH})`)
    }
    if (!FLOW_UUID_RE.test(flowId)) {
      throw new Error(`ExecuteFlow: invalid flow id "${flowId}"`)
    }

    let row: { name: string; flow_data: unknown } | undefined
    try {
      const { records } = await runQuery<{ name: string; flow_data: unknown }>(
        `SELECT name, flow_data FROM flows WHERE id = $1::uuid`,
        [flowId],
      )
      row = records[0]
    } catch (err) {
      log.error('subflow lookup failed', { flowId, error: String(err) })
      throw new Error(`ExecuteFlow: flow lookup failed — ${String(err)}`)
    }
    if (!row) {
      throw new Error(`ExecuteFlow: flow "${flowId}" not found`)
    }

    const flowData = row.flow_data as import('@dagents/workflow').FlowData
    if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
      throw new Error(`ExecuteFlow: flow "${row.name}" (${flowId}) has invalid flow data`)
    }

    const registry = new NodeRegistry()
    registry.registerMany(allNodes())
    const result = await new DagExecutor(registry).execute(flowData, input, {
      chatId: deps.chatId,
      runId: deps.runId,
      state: {},
      isLastNode: false,
      llmClient: deps.llmClient,
      agentFetcher: deps.agentFetcher,
      toolRegistry: deps.toolRegistry,
      historyRetriever: deps.historyRetriever,
      humanInputResolver: deps.humanInputResolver,
      flowExecutor: createFlowExecutor(deps, depth + 1),
    })

    deps.onExecutedNodes?.(result.executedNodes)

    if (result.status !== 'success') {
      throw new Error(`ExecuteFlow: subflow "${row.name}" failed — ${result.error ?? 'unknown error'}`)
    }
    return result.finalOutput ?? {}
  }
}
