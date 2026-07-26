import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from '../app.js'
import { randomUUID } from 'node:crypto'

const mockRunQuery = vi.fn()

vi.mock('@mil/db', () => ({
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64')
}

function mockProviderRow(overrides: Record<string, unknown> = {}) {
  const id = randomUUID()
  const now = new Date('2026-07-26T10:00:00.000Z')
  return {
    id,
    directory_id: null,
    name: 'Test Provider',
    provider_type: 'openai_compatible',
    base_url: 'https://api.example.com/v1',
    api_key: base64Encode('sk-test12345678'),
    default_model: 'gpt-4',
    models: [],
    status: 'active',
    remark: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('GET /api/v1/llm-providers — list', () => {
  it('returns all providers with masked api keys', async () => {
    const row = mockProviderRow({ name: 'Provider A' })
    const row2 = mockProviderRow({ name: 'Provider B', id: randomUUID() })
    mockRunQuery.mockResolvedValueOnce({ records: [row, row2] })

    const res = await app.request('/api/v1/llm-providers', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { providers: Array<{ id: string; name: string; apiKey: string }> } }
    expect(body.success).toBe(true)
    expect(body.data.providers).toHaveLength(2)
    expect(body.data.providers[0].name).toBe('Provider A')
    expect(body.data.providers[0].apiKey).toBe('sk-t...5678')
    expect(body.data.providers[1].name).toBe('Provider B')
    expect(body.data.providers[1].apiKey).toBe('sk-t...5678')
  })
})

describe('POST /api/v1/llm-providers — create', () => {
  it('creates a provider with base64 encoded api key', async () => {
    const row = mockProviderRow({ name: 'New Provider' })
    mockRunQuery.mockResolvedValueOnce({ records: [row] })

    const res = await app.request('/api/v1/llm-providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'New Provider',
        baseUrl: 'https://api.new.com/v1',
        apiKey: 'sk-newkey123456',
        defaultModel: 'gpt-3.5-turbo',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { provider: { name: string; apiKey: string } } }
    expect(body.success).toBe(true)
    expect(body.data.provider.name).toBe('New Provider')
    expect(body.data.provider.apiKey).toBe('sk-t...5678')

    const callArgs = mockRunQuery.mock.calls[0]
    const sql = callArgs[0] as string
    const params = callArgs[1] as unknown[]
    expect(sql).toContain('INSERT INTO llm_providers')
    const apiKeyParam = params[3] as string
    expect(Buffer.from(apiKeyParam, 'base64').toString('utf-8')).toBe('sk-newkey123456')
  })

  it('returns 400 when required fields are missing', async () => {
    const res = await app.request('/api/v1/llm-providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Provider' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('invalid body')
  })
})

describe('GET /api/v1/llm-providers/:id — get', () => {
  it('returns a single provider with masked api key', async () => {
    const id = randomUUID()
    const row = mockProviderRow({ id, name: 'Single Provider' })
    mockRunQuery.mockResolvedValueOnce({ records: [row] })

    const res = await app.request(`/api/v1/llm-providers/${id}`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { provider: { id: string; name: string; apiKey: string } } }
    expect(body.success).toBe(true)
    expect(body.data.provider.id).toBe(id)
    expect(body.data.provider.name).toBe('Single Provider')
    expect(body.data.provider.apiKey).toBe('sk-t...5678')
  })

  it('returns 404 for missing provider', async () => {
    const id = randomUUID()
    mockRunQuery.mockResolvedValueOnce({ records: [] })

    const res = await app.request(`/api/v1/llm-providers/${id}`, { method: 'GET' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('provider not found')
  })

  it('returns 400 for malformed id', async () => {
    const res = await app.request('/api/v1/llm-providers/not-a-uuid', { method: 'GET' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('invalid provider id')
  })
})

describe('PATCH /api/v1/llm-providers/:id — update', () => {
  it('updates provider fields', async () => {
    const id = randomUUID()
    const row = mockProviderRow({ id, name: 'Updated Name', status: 'disabled' })
    mockRunQuery.mockResolvedValueOnce({ records: [row] })

    const res = await app.request(`/api/v1/llm-providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name', status: 'disabled' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { provider: { name: string; status: string } } }
    expect(body.success).toBe(true)
    expect(body.data.provider.name).toBe('Updated Name')
    expect(body.data.provider.status).toBe('disabled')

    const callArgs = mockRunQuery.mock.calls[0]
    const sql = callArgs[0] as string
    const params = callArgs[1] as unknown[]
    expect(sql).toContain('UPDATE llm_providers')
    expect(params[0]).toBe('Updated Name')
    expect(params[1]).toBe('disabled')
    expect(params[2]).toBe(id)
  })

  it('returns 404 for missing id', async () => {
    const id = randomUUID()
    mockRunQuery.mockResolvedValueOnce({ records: [] })

    const res = await app.request(`/api/v1/llm-providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('provider not found')
  })
})

describe('DELETE /api/v1/llm-providers/:id — delete', () => {
  it('deletes a provider', async () => {
    const id = randomUUID()
    mockRunQuery.mockResolvedValueOnce({ records: [{ id }] })

    const res = await app.request(`/api/v1/llm-providers/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { deleted: boolean; id: string } }
    expect(body.success).toBe(true)
    expect(body.data.deleted).toBe(true)
    expect(body.data.id).toBe(id)
  })

  it('returns 404 for missing id', async () => {
    const id = randomUUID()
    mockRunQuery.mockResolvedValueOnce({ records: [] })

    const res = await app.request(`/api/v1/llm-providers/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('provider not found')
  })
})

describe('POST /api/v1/llm-providers/:id/test — test connection', () => {
  it('tests connection successfully', async () => {
    const id = randomUUID()
    const row = mockProviderRow({ id, base_url: 'https://api.test.com/v1' })
    mockRunQuery.mockResolvedValueOnce({ records: [row] })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'model-1' }, { id: 'model-2' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const res = await app.request(`/api/v1/llm-providers/${id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { models: unknown[] } }
    expect(body.success).toBe(true)
    expect(body.data.models).toHaveLength(2)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const fetchUrl = mockFetch.mock.calls[0][0] as string
    const fetchOpts = mockFetch.mock.calls[0][1] as { headers: Record<string, string> }
    expect(fetchUrl).toBe('https://api.test.com/v1/models')
    expect(fetchOpts.headers.Authorization).toBe('Bearer sk-test12345678')

    vi.unstubAllGlobals()
  })

  it('returns error on connection failure', async () => {
    const id = randomUUID()
    const row = mockProviderRow({ id })
    mockRunQuery.mockResolvedValueOnce({ records: [row] })

    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', mockFetch)

    const res = await app.request(`/api/v1/llm-providers/${id}/test`, { method: 'POST' })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('connection test failed')

    vi.unstubAllGlobals()
  })
})
