/**
 * 动态选项源 —— options 类型参数的下拉数据在 console 侧注入（保持
 * `@dagents/workflow` 纯净）。替代 vendor 时代 BFF /nodes 路由的动态拼装
 * （agentId 下拉 + generator 的 chatmodels 合并）。
 *
 * 约定：静态 options 为空数组的参数若命中这里的 provider，则用动态结果；
 * 否则维持静态（如 http method 的 GET/POST/...）。
 */

import { FALLBACK_MODEL, listChatModels, type AgentLike, type ProviderLike } from '@/lib/flow-generator'

export interface OptionItem {
  value: string
  label: string
  description?: string
}

interface AgentRow {
  id: string
  name: string
  kind?: string
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'content-type': 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchAgents(): Promise<AgentRow[]> {
  const body = await fetchJson<{ data?: { rows?: AgentRow[] } | AgentRow[] } | AgentRow[]>('/api/agents')
  const rows = Array.isArray(body) ? body : ((body as { data?: { rows?: AgentRow[] } })?.data?.rows ?? (body as { data?: AgentRow[] })?.data)
  return Array.isArray(rows) ? rows.filter((a) => typeof a?.id === 'string') : []
}

async function fetchProviders(): Promise<ProviderLike[]> {
  const body = await fetchJson<{ data?: ProviderLike[] } | ProviderLike[]>('/api/llm-providers')
  const rows = Array.isArray(body) ? body : (body?.data ?? [])
  return Array.isArray(rows) ? rows : []
}

let cachedAgents: { at: number; value: OptionItem[] } | null = null
let cachedModels: { at: number; value: OptionItem[] } | null = null
const TTL = 30_000

/** platformAgent 的 agentId 下拉：平台 agents 表实时列表。 */
export async function agentOptions(force = false): Promise<OptionItem[]> {
  if (!force && cachedAgents && Date.now() - cachedAgents.at < TTL) return cachedAgents.value
  const agents = await fetchAgents()
  const value = agents.map((a) => ({
    value: a.id,
    label: a.name,
    ...(a.kind ? { description: a.kind } : {}),
  }))
  cachedAgents = { at: Date.now(), value }
  return value
}

/** model 下拉：providers `providerId::model` + agents `agent::<id>` + CLI 兜底。 */
export async function modelOptions(force = false): Promise<OptionItem[]> {
  if (!force && cachedModels && Date.now() - cachedModels.at < TTL) return cachedModels.value
  const [providers, agents] = await Promise.all([fetchProviders(), fetchAgents()])
  const models = listChatModels(providers, agents as AgentLike[])
  const value = models.map((m) => ({
    value: m.name,
    label: m.label,
    ...(m.description ? { description: m.description } : {}),
  }))
  cachedModels = { at: Date.now(), value }
  return value
}

/** 兜底单条（缓存未命中时的同步渲染用，与 lib/flow-generator 语义一致）。 */
export const FALLBACK_MODEL_OPTION: OptionItem = {
  value: FALLBACK_MODEL.name,
  label: FALLBACK_MODEL.label,
  description: FALLBACK_MODEL.description,
}
