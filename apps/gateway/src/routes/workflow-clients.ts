/**
 * LLM client + agent fetcher for workflow execution.
 *
 * The DagExecutor needs an `llmClient` (for LLM/Agent/PlatformAgent nodes) and
 * an `agentFetcher` (for PlatformAgentNode). Both are provided by the gateway
 * because they need DB access — the workflow package stays DB-free.
 */

import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { IExecutionContext, PlatformAgentConfig, ITokenUsage, IToolSchema, IToolCall } from '@dagents/workflow'

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
 * Returns `{ text, usage }` where `usage` is the token usage reported by the
 * provider. If no provider is configured, throws an error — the calling node
 * will catch it and mark itself as failed.
 */
export function createLlmClient(): NonNullable<IExecutionContext['llmClient']> {
  return {
    async chat(params) {
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
        stream: false,
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

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
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
