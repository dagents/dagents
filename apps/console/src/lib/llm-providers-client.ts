/**
 * Browser-side LLM provider admin client.
 *
 * Thin fetch wrapper over the console's own `/api/llm-providers/*` proxy routes
 * (which forward to the gateway). Kept in a small module, rather than inline
 * in the settings component, so the CRUD calls are testable in isolation and
 * the component stays focused on rendering.
 *
 * Envelope: the gateway uses `{ success, data?, error? }` (CLAUDE.md API
 * convention). `unwrap()` lifts `data` out on success and throws an `Error`
 * carrying `error` on failure, so callers can `try/catch` a single string.
 */

import type { LlmProvider, LlmProviderFormInput } from './llm-providers'

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
  detail?: unknown
}

async function unwrap<T>(res: Response): Promise<T> {
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    throw new Error(`llm provider request failed (${res.status})`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success) {
    throw new Error(body.error ?? `llm provider request failed (${res.status})`)
  }
  return body.data as T
}

export interface ListProvidersResult {
  providers: LlmProvider[]
}

export async function listLlmProviders(signal?: AbortSignal): Promise<ListProvidersResult> {
  const res = await fetch('/api/llm-providers', { method: 'GET', cache: 'no-store', signal })
  return await unwrap<ListProvidersResult>(res)
}

export async function getLlmProvider(id: string, signal?: AbortSignal): Promise<LlmProvider> {
  const res = await fetch(`/api/llm-providers/${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store', signal })
  const data = await unwrap<{ provider: LlmProvider }>(res)
  return data.provider
}

export async function createLlmProvider(input: LlmProviderFormInput): Promise<LlmProvider> {
  const res = await fetch('/api/llm-providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await unwrap<{ provider: LlmProvider }>(res)
  return data.provider
}

export async function updateLlmProvider(id: string, input: Partial<LlmProviderFormInput>): Promise<LlmProvider> {
  const res = await fetch(`/api/llm-providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await unwrap<{ provider: LlmProvider }>(res)
  return data.provider
}

export async function deleteLlmProvider(id: string): Promise<{ deleted: boolean; id: string }> {
  const res = await fetch(`/api/llm-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return await unwrap<{ deleted: boolean; id: string }>(res)
}

export async function testLlmProvider(id: string): Promise<{ models: unknown[] }> {
  const res = await fetch(`/api/llm-providers/${encodeURIComponent(id)}/test`, { method: 'POST' })
  return await unwrap<{ models: unknown[] }>(res)
}
