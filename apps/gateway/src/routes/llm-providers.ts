import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { recordAudit } from '../audit.js'
import { decryptSecret, encrypt, encryptionConfigured } from '../crypto.js'

export const llmProviderRoutes = new Hono()

const log = createLogger({ svc: 'gateway:llm-providers' })

const ok = <T>(c: Context, data: T) => c.json({ success: true, data })
const fail = (
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  extra?: Record<string, unknown>,
) => c.json({ success: false, error, ...extra }, status)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const createBodySchema = z.object({
  name: z.string().min(1),
  providerType: z.string().min(1).optional(),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  models: z.array(z.unknown()).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  remark: z.string().optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).optional(),
  providerType: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  models: z.array(z.unknown()).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  remark: z.string().optional(),
})

interface LlmProviderRow {
  id: string
  directory_id: string | null
  name: string
  provider_type: string
  base_url: string
  api_key: string
  default_model: string
  models: unknown
  status: string
  remark: string | null
  created_at: Date
  updated_at: Date
}

function maskApiKey(key: string): string {
  if (key.length >= 8) {
    return `${key.slice(0, 4)}...${key.slice(-4)}`
  }
  if (key.length > 3) {
    return `${key.slice(0, 3)}...`
  }
  return '...'
}

/**
 * Encrypt an API key for at-rest storage. Uses AES-256-GCM when ENCRYPTION_KEY
 * is configured; falls back to legacy Base64 for dev without encryption (with
 * a log warning) so the gateway still boots.
 */
function encodeApiKey(plain: string): string {
  if (encryptionConfigured()) {
    return encrypt(plain)
  }
  log.warn('ENCRYPTION_KEY not set — API key stored with legacy Base64 (not secure!)')
  return Buffer.from(plain).toString('base64')
}

function normalizeProvider(r: LlmProviderRow) {
  let models: unknown[] = []
  if (Array.isArray(r.models)) {
    models = r.models
  }
  const decodedKey = decryptSecret(r.api_key)
  return {
    id: r.id,
    directoryId: r.directory_id,
    name: r.name,
    providerType: r.provider_type,
    baseUrl: r.base_url,
    apiKey: maskApiKey(decodedKey),
    defaultModel: r.default_model,
    models,
    status: r.status,
    remark: r.remark,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
  }
}

llmProviderRoutes.get('/', async (c) => {
  let rows: LlmProviderRow[]
  try {
    const { records } = await runQuery<LlmProviderRow>(
      `SELECT id, directory_id, name, provider_type, base_url, api_key,
              default_model, models, status, remark, created_at, updated_at
         FROM llm_providers
         ORDER BY updated_at DESC`,
    )
    rows = records
  } catch (err) {
    log.error('llm provider list query failed', { error: String(err) })
    return fail(c, 502, 'llm provider list failed')
  }

  return ok(c, {
    providers: rows.map((r) => normalizeProvider(r)),
  })
})

llmProviderRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid provider id', { id })
  }

  let row: LlmProviderRow | null
  try {
    const { records } = await runQuery<LlmProviderRow>(
      `SELECT id, directory_id, name, provider_type, base_url, api_key,
              default_model, models, status, remark, created_at, updated_at
         FROM llm_providers
         WHERE id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('llm provider detail query failed', { id, error: String(err) })
    return fail(c, 502, 'llm provider detail failed')
  }
  if (!row) {
    return fail(c, 404, 'provider not found', { id })
  }

  return ok(c, { provider: normalizeProvider(row) })
})

llmProviderRoutes.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = createBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  const encodedApiKey = encodeApiKey(data.apiKey)

  let row: LlmProviderRow | null
  try {
    const { records } = await runQuery<LlmProviderRow>(
      `INSERT INTO llm_providers (name, provider_type, base_url, api_key,
                                  default_model, models, status, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, directory_id, name, provider_type, base_url, api_key,
                 default_model, models, status, remark, created_at, updated_at`,
      [
        data.name,
        data.providerType ?? 'openai_compatible',
        data.baseUrl,
        encodedApiKey,
        data.defaultModel,
        JSON.stringify(data.models ?? []),
        data.status ?? 'active',
        data.remark ?? null,
      ],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('llm provider create failed', { error: String(err) })
    return fail(c, 502, 'llm provider create failed')
  }
  if (!row) {
    return fail(c, 502, 'llm provider create failed')
  }

  await recordAudit(c, {
    action: 'llm_provider.create',
    target: { type: 'llm_provider', id: row.id },
    detail: { name: data.name, providerType: data.providerType ?? 'openai_compatible', baseUrl: data.baseUrl, defaultModel: data.defaultModel },
  })

  return ok(c, { provider: normalizeProvider(row) })
})

llmProviderRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid provider id', { id })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid json body')
  }
  const parsed = updateBodySchema.safeParse(body)
  if (!parsed.success) {
    return fail(c, 400, 'invalid body', { detail: parsed.error.message })
  }
  const data = parsed.data

  const sets: string[] = []
  const params: unknown[] = []

  if (data.name !== undefined) {
    params.push(data.name)
    sets.push(`name = $${params.length}`)
  }
  if (data.baseUrl !== undefined) {
    params.push(data.baseUrl)
    sets.push(`base_url = $${params.length}`)
  }
  if (data.apiKey !== undefined) {
    params.push(encodeApiKey(data.apiKey))
    sets.push(`api_key = $${params.length}`)
  }
  if (data.defaultModel !== undefined) {
    params.push(data.defaultModel)
    sets.push(`default_model = $${params.length}`)
  }
  if (data.models !== undefined) {
    params.push(JSON.stringify(data.models))
    sets.push(`models = $${params.length}`)
  }
  if (data.status !== undefined) {
    params.push(data.status)
    sets.push(`status = $${params.length}`)
  }
  if (data.remark !== undefined) {
    params.push(data.remark)
    sets.push(`remark = $${params.length}`)
  }

  if (sets.length === 0) {
    let existing: LlmProviderRow | null
    try {
      const { records } = await runQuery<LlmProviderRow>(
        `SELECT id, directory_id, name, provider_type, base_url, api_key,
                default_model, models, status, remark, created_at, updated_at
           FROM llm_providers
           WHERE id = $1`,
        [id],
      )
      existing = records[0] ?? null
    } catch (err) {
      log.error('llm provider detail query failed', { id, error: String(err) })
      return fail(c, 502, 'llm provider update failed')
    }
    if (!existing) {
      return fail(c, 404, 'provider not found', { id })
    }
    return ok(c, { provider: normalizeProvider(existing) })
  }

  params.push(id)
  const idParam = `$${params.length}`

  let row: LlmProviderRow | null
  try {
    const { records } = await runQuery<LlmProviderRow>(
      `UPDATE llm_providers
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = ${idParam}
       RETURNING id, directory_id, name, provider_type, base_url, api_key,
                 default_model, models, status, remark, created_at, updated_at`,
      params,
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('llm provider update failed', { id, error: String(err) })
    return fail(c, 502, 'llm provider update failed')
  }
  if (!row) {
    return fail(c, 404, 'provider not found', { id })
  }

  const updateDetail: Record<string, unknown> = {}
  if (data.name !== undefined) updateDetail.name = data.name
  if (data.baseUrl !== undefined) updateDetail.baseUrl = data.baseUrl
  if (data.defaultModel !== undefined) updateDetail.defaultModel = data.defaultModel
  if (data.status !== undefined) updateDetail.status = data.status
  if (data.remark !== undefined) updateDetail.remark = data.remark
  if (data.providerType !== undefined) updateDetail.providerType = data.providerType

  await recordAudit(c, {
    action: 'llm_provider.update',
    target: { type: 'llm_provider', id },
    detail: updateDetail,
  })

  return ok(c, { provider: normalizeProvider(row) })
})

llmProviderRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid provider id', { id })
  }

  let deletedId: string | null
  try {
    const { records } = await runQuery<{ id: string }>(
      `DELETE FROM llm_providers WHERE id = $1 RETURNING id`,
      [id],
    )
    deletedId = records[0]?.id ?? null
  } catch (err) {
    log.error('llm provider delete failed', { id, error: String(err) })
    return fail(c, 502, 'llm provider delete failed')
  }
  if (!deletedId) {
    return fail(c, 404, 'provider not found', { id })
  }

  await recordAudit(c, {
    action: 'llm_provider.delete',
    target: { type: 'llm_provider', id: deletedId },
    detail: {},
  })

  return ok(c, { deleted: true, id: deletedId })
})

llmProviderRoutes.post('/:id/test', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    return fail(c, 400, 'invalid provider id', { id })
  }

  let row: LlmProviderRow | null
  try {
    const { records } = await runQuery<LlmProviderRow>(
      `SELECT id, directory_id, name, provider_type, base_url, api_key,
              default_model, models, status, remark, created_at, updated_at
         FROM llm_providers
         WHERE id = $1`,
      [id],
    )
    row = records[0] ?? null
  } catch (err) {
    log.error('llm provider detail query failed', { id, error: String(err) })
    return fail(c, 502, 'llm provider test failed')
  }
  if (!row) {
    return fail(c, 404, 'provider not found', { id })
  }

  const decodedKey = decryptSecret(row.api_key)
  const baseUrl = row.base_url.endsWith('/') ? row.base_url.slice(0, -1) : row.base_url
  const testUrl = `${baseUrl}/models`

  try {
    const resp = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${decodedKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      log.warn('llm provider test failed', { id, status: resp.status })
      return fail(c, 502, 'connection test failed', { upstreamStatus: resp.status, detail: text.slice(0, 500) })
    }

    const data = await resp.json()
    const models = Array.isArray(data) ? data : (data as { data?: unknown[] }).data ?? []
    return ok(c, { models })
  } catch (err) {
    log.error('llm provider test request failed', { id, error: String(err) })
    return fail(c, 502, 'connection test failed', { detail: String(err) })
  }
})
