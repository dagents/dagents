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

/** Reset the provider cache — call before each workflow run. */
export function resetProviderCache(): void {
  cachedProvider = null
  providerFetchPromise = null
}

/** Decode the base64-encoded API key stored in llm_providers. */
function decodeApiKey(encoded: string): string {
  try {
    return Buffer.from(encoded, 'base64').toString('utf-8')
  } catch {
    return encoded
  }
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
export function createLlmClient(): NonNullable<IExecutionContext['llmClient']> {
  return {
    async chat(params) {
      const { url, headers, body } = await prepareRequest(params, false)
      const res = await fetch(url, { method: 'POST', headers, body })

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
      const { url, headers, body } = await prepareRequest(params, true)
      const res = await fetch(url, { method: 'POST', headers, body })

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

      try {
        for (;;) {
          const { done, value } = await reader.read()
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
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const provider = await getActiveProvider()
  if (!provider) {
    throw new Error(
      'No active LLM provider configured. Add one in the LLM Providers settings.',
    )
  }

  const model = params.model || provider.default_model
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
        instructions: row.instructions,
        model: row.model,
        kind: row.kind,
        skills: Array.isArray(row.skills) ? row.skills : [],
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
