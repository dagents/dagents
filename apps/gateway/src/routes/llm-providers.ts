import { Hono } from 'hono'
import { z } from 'zod'
import { createLogger } from '@dagents/shared'
import { recordAudit } from '../audit.js'
import { decryptSecret } from '../crypto.js'
import {
  listLlmProviders,
  getLlmProviderById,
  createLlmProvider,
  updateLlmProviderFields,
  deleteLlmProvider,
  normalizeProvider,
  type LlmProviderRow,
} from '../repositories/llm-providers.repo.js'
import { ok, fail } from '../lib/http.js'
import { UUID_RE } from '../lib/http.js'

export const llmProviderRoutes = new Hono()

const log = createLogger({ svc: 'gateway:llm-providers' })


/** base_url 必须是 http(s) 绝对 URL —— gateway 会向它发请求并附带解密后的 API key。 */
const baseUrlSchema = z
  .string()
  .min(1)
  .refine(
    (v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'baseUrl must be an absolute http(s) URL' },
  )

const createBodySchema = z.object({
  name: z.string().min(1),
  providerType: z.string().min(1).optional(),
  baseUrl: baseUrlSchema,
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  models: z.array(z.unknown()).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  remark: z.string().optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).optional(),
  providerType: z.string().min(1).optional(),
  baseUrl: baseUrlSchema.optional(),
  apiKey: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  models: z.array(z.unknown()).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  remark: z.string().optional(),
})

llmProviderRoutes.get('/', async (c) => {
  let rows: LlmProviderRow[]
  try {
    rows = await listLlmProviders()
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
    row = await getLlmProviderById(id)
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

  let row: LlmProviderRow | null
  try {
    row = await createLlmProvider({
      name: data.name,
      providerType: data.providerType ?? 'openai_compatible',
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      defaultModel: data.defaultModel,
      modelsJson: JSON.stringify(data.models ?? []),
      status: data.status ?? 'active',
      remark: data.remark ?? null,
    })
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

  const hasUpdates =
    data.name !== undefined ||
    data.providerType !== undefined ||
    data.baseUrl !== undefined ||
    data.apiKey !== undefined ||
    data.defaultModel !== undefined ||
    data.models !== undefined ||
    data.status !== undefined ||
    data.remark !== undefined

  if (!hasUpdates) {
    let existing: LlmProviderRow | null
    try {
      existing = await getLlmProviderById(id)
    } catch (err) {
      log.error('llm provider detail query failed', { id, error: String(err) })
      return fail(c, 502, 'llm provider update failed')
    }
    if (!existing) {
      return fail(c, 404, 'provider not found', { id })
    }
    return ok(c, { provider: normalizeProvider(existing) })
  }

  let row: LlmProviderRow | null
  try {
    row = await updateLlmProviderFields(id, {
      name: data.name,
      providerType: data.providerType,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      defaultModel: data.defaultModel,
      modelsJson: data.models !== undefined ? JSON.stringify(data.models) : undefined,
      status: data.status,
      remark: data.remark,
    })
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
    deletedId = await deleteLlmProvider(id)
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
    row = await getLlmProviderById(id)
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
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) {
      // 不回显上游响应体：/test 是一个服务端 fetch 通道，把响应内容带回
      // 给调用方等于一个读型 SSRF 原语（内网元数据端点等）。只报状态码。
      log.warn('llm provider test failed', { id, status: resp.status })
      return fail(c, 502, 'connection test failed', { upstreamStatus: resp.status })
    }

    const data = await resp.json()
    const models = Array.isArray(data) ? data : (data as { data?: unknown[] }).data ?? []
    return ok(c, { models })
  } catch (err) {
    log.error('llm provider test request failed', { id, error: String(err) })
    return fail(c, 502, 'connection test failed', { detail: String(err) })
  }
})
