/**
 * LLM Provider type model.
 *
 * The console never talks to the gateway LLM provider API directly from the
 * browser — every CRUD goes browser → Next `/api/llm-providers/*` → gateway
 * `/api/v1/llm-providers/*`. The API key is stored base64-encoded on the
 * server and returned masked (e.g. `sk-ab••••••1234`) — the raw key never
 * reaches the browser.
 */

export type LlmProviderStatus = 'active' | 'disabled'

/**
 * An LLM provider as the console renders it. `apiKey` is always masked
 * (never the raw key); `id` is a UUID.
 */
export interface LlmProvider {
  id: string
  directoryId: string | null
  name: string
  providerType: string
  baseUrl: string
  /** Masked API key, e.g. `sk-ab••••••1234`. Never the raw key. */
  apiKey: string
  defaultModel: string
  models: unknown[]
  status: LlmProviderStatus
  remark: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Create/edit form input for an LLM provider. `apiKey` is the plaintext key
 * entered by the user — sent only on create or when the user explicitly
 * updates it (empty/undefined = leave unchanged on edit).
 */
export interface LlmProviderFormInput {
  name: string
  providerType?: string
  baseUrl: string
  apiKey?: string
  defaultModel: string
  models?: unknown[]
  status?: LlmProviderStatus
  remark?: string
}

const STATUS_CN: Record<LlmProviderStatus, string> = {
  active: '启用',
  disabled: '禁用',
}

export function llmProviderStatusText(s: LlmProviderStatus): string {
  return STATUS_CN[s] ?? s
}
