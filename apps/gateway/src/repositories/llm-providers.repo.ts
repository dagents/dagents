/**
 * llm-providers.repo.ts — `llm_providers` 表的数据访问层。
 *
 * llm_providers：LLM Provider 配置（base_url + api_key（AES-GCM 加密存储，
 * 未配 ENCRYPTION_KEY 时回落 Base64）+ 默认模型 + 模型清单）。CRUD 面向
 * 设置页（api_key 出参打码）；代理转发面（routes/llm.ts）只取解密所需的
 * 最小列投影。
 */
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { decryptSecret, encrypt, encryptionConfigured } from '../crypto.js'

const log = createLogger({ svc: 'gateway:llm-providers' })

export interface LlmProviderRow {
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

export function normalizeProvider(r: LlmProviderRow) {
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

export async function listLlmProviders(): Promise<LlmProviderRow[]> {
  const { records } = await runQuery<LlmProviderRow>(
    `SELECT id, directory_id, name, provider_type, base_url, api_key,
            default_model, models, status, remark, created_at, updated_at
       FROM llm_providers
       ORDER BY updated_at DESC`,
  )
  return records
}

export async function getLlmProviderById(id: string): Promise<LlmProviderRow | null> {
  const { records } = await runQuery<LlmProviderRow>(
    `SELECT id, directory_id, name, provider_type, base_url, api_key,
            default_model, models, status, remark, created_at, updated_at
       FROM llm_providers
       WHERE id = $1`,
    [id],
  )
  return records[0] ?? null
}

export async function createLlmProvider(input: {
  name: string
  providerType: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  modelsJson: string
  status: string
  remark?: string | null
}): Promise<LlmProviderRow | null> {
  const { records } = await runQuery<LlmProviderRow>(
    `INSERT INTO llm_providers (name, provider_type, base_url, api_key,
                                default_model, models, status, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, directory_id, name, provider_type, base_url, api_key,
               default_model, models, status, remark, created_at, updated_at`,
    [
      input.name,
      input.providerType,
      input.baseUrl,
      encodeApiKey(input.apiKey),
      input.defaultModel,
      input.modelsJson,
      input.status,
      input.remark ?? null,
    ],
  )
  return records[0] ?? null
}

/** PATCH 动态更新：只写提供的列（apiKey 在此加密）。 */
export async function updateLlmProviderFields(
  id: string,
  patch: {
    name?: string
    providerType?: string
    baseUrl?: string
    apiKey?: string
    defaultModel?: string
    modelsJson?: string
    status?: string
    remark?: string
  },
): Promise<LlmProviderRow | null> {
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.providerType !== undefined) {
    // schema 接受了 providerType 但此前 SET 构建器没有对应分支 —— PATCH
    // {providerType} 会落进"无字段可更新"分支返回 200，变更被静默丢弃。
    params.push(patch.providerType)
    sets.push(`provider_type = $${params.length}`)
  }
  if (patch.baseUrl !== undefined) {
    params.push(patch.baseUrl)
    sets.push(`base_url = $${params.length}`)
  }
  if (patch.apiKey !== undefined) {
    params.push(encodeApiKey(patch.apiKey))
    sets.push(`api_key = $${params.length}`)
  }
  if (patch.defaultModel !== undefined) {
    params.push(patch.defaultModel)
    sets.push(`default_model = $${params.length}`)
  }
  if (patch.modelsJson !== undefined) {
    params.push(patch.modelsJson)
    sets.push(`models = $${params.length}`)
  }
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
  }
  if (patch.remark !== undefined) {
    params.push(patch.remark)
    sets.push(`remark = $${params.length}`)
  }

  params.push(id)
  const idParam = `$${params.length}`

  const { records } = await runQuery<LlmProviderRow>(
    `UPDATE llm_providers
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = ${idParam}
     RETURNING id, directory_id, name, provider_type, base_url, api_key,
               default_model, models, status, remark, created_at, updated_at`,
    params,
  )
  return records[0] ?? null
}

export async function deleteLlmProvider(id: string): Promise<string | null> {
  const { records } = await runQuery<{ id: string }>(
    `DELETE FROM llm_providers WHERE id = $1 RETURNING id`,
    [id],
  )
  return records[0]?.id ?? null
}

// ── 代理转发面（routes/llm.ts）：最小列投影，api_key 由调用方解密 ──

export interface LlmProviderProxyRow {
  id: string
  base_url: string
  api_key: string
  status: string
}

export async function getProviderProxyConfigById(id: string): Promise<LlmProviderProxyRow | null> {
  const { records } = await runQuery<LlmProviderProxyRow>(
    `SELECT id, base_url, api_key, status FROM llm_providers WHERE id = $1`,
    [id],
  )
  return records[0] ?? null
}

export async function getFirstActiveProviderProxyConfig(): Promise<LlmProviderProxyRow | null> {
  const { records } = await runQuery<LlmProviderProxyRow>(
    `SELECT id, base_url, api_key, status FROM llm_providers WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`,
  )
  return records[0] ?? null
}
