/**
 * agent-library.ts — Agent 人格库的 console API client。
 *
 * 镜像 `agent-templates.ts` 的 unwrap 模式：所有调用打 console 代理
 * `/api/agent-library/*`（转发到 gateway `/api/v1/agent-library/*`）。
 * 人格寻址键是 `<division>/<slug>`（gateway 由 frontmatter name slug 化）。
 */

import { apiFetch } from '@/lib/api'

export type PersonaProfile = 'full' | 'slim' | 'minimal'

export interface AgentLibraryEntrySummary {
  id: string
  division: string
  name: string
  description: string
  emoji: string | null
  color: string | null
  vibe: string | null
  tools: string[] | null
  sizeBytes: number
  /** 提供该条目的根类型（builtin = 产品预置内容，广场渲染「内置」角标）。 */
  source?: 'builtin' | 'custom' | 'managed' | 'default'
  /** frontmatter 建议运行时（快速开始档位人格锁定 kind/model；instantiate 默认采用）。 */
  suggestedKind?: string | null
  suggestedModel?: string | null
}

export interface AgentLibraryDivision {
  key: string
  label: string
  color: string | null
  icon: string | null
}

export interface AgentLibraryRootInfo {
  source: string
  dir: string
  rank: number
}

export interface AgentLibraryCatalog {
  divisions: AgentLibraryDivision[]
  entries: AgentLibraryEntrySummary[]
  roots: AgentLibraryRootInfo[]
}

export interface AgentLibraryDetail extends AgentLibraryEntrySummary {
  body: string
  filePath: string
  rawSha256: string
  previews: { profile: PersonaProfile; chars: number; preview: string }[]
  instantiated: { agentId: string; drift: PersonaDriftState } | null
}

export type PersonaDriftState =
  'up-to-date' | 'upstream-updated' | 'locally-modified' | 'diverged' | 'missing-upstream'

export interface AgentLibraryDriftItem {
  agentId: string
  libraryId: string
  name: string
  division: string | null
  state: PersonaDriftState
  currentProfile: PersonaProfile | null
}

function splitId(id: string): { division: string; slug: string } {
  const idx = id.indexOf('/')
  if (idx <= 0 || idx === id.length - 1) throw new Error(`非法的库 id：${id}`)
  return { division: id.slice(0, idx), slug: id.slice(idx + 1) }
}

export async function fetchAgentLibrary(
  opts: { division?: string; refresh?: boolean } = {},
): Promise<AgentLibraryCatalog> {
  const qs = new URLSearchParams()
  if (opts.division) qs.set('division', opts.division)
  if (opts.refresh) qs.set('refresh', 'true')
  const query = qs.toString()
  return apiFetch<AgentLibraryCatalog>(
    `/api/agent-library${query ? `?${query}` : ''}`,
    undefined,
    '加载人格库',
  )
}

export async function fetchAgentLibraryEntry(id: string): Promise<AgentLibraryDetail> {
  const { division, slug } = splitId(id)
  return apiFetch<AgentLibraryDetail>(
    `/api/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}`,
    undefined,
    '加载人格详情',
  )
}

export async function fetchAgentLibraryDrift(): Promise<AgentLibraryDriftItem[]> {
  const data = await apiFetch<{ items: AgentLibraryDriftItem[] }>(
    '/api/agent-library/drift',
    undefined,
    '加载同步状态',
  )
  return data.items
}

export interface InstantiatePersonaRequest {
  profile?: PersonaProfile
  kind?: string
  model?: string
}

export async function instantiateAgentFromLibrary(
  id: string,
  req: InstantiatePersonaRequest = {},
): Promise<{ id: string; libraryId: string; kind: string; profile: PersonaProfile }> {
  const { division, slug } = splitId(id)
  return apiFetch(
    `/api/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}/instantiate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    },
    '启用人格',
  )
}

export async function reimportAgentFromLibrary(
  id: string,
  req: { confirm?: boolean; profile?: PersonaProfile } = {},
): Promise<{ id: string; profile: PersonaProfile; fromState: PersonaDriftState }> {
  const { division, slug } = splitId(id)
  return apiFetch(
    `/api/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}/reimport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    },
    '重新导入',
  )
}

export async function addAgentLibraryRoot(dir: string): Promise<{ dir: string }> {
  return apiFetch(
    '/api/agent-library/roots',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    },
    '添加挂载目录',
  )
}

export async function removeAgentLibraryRoot(dir: string): Promise<{ dir: string }> {
  return apiFetch(
    `/api/agent-library/roots?dir=${encodeURIComponent(dir)}`,
    { method: 'DELETE' },
    '移除挂载目录',
  )
}

// ── 团队场景工作流模板（Phase 3） ──────────────────────────────────────

export interface TeamTemplateMember {
  persona: string
  label: string
  libraryId: string | null
  available: boolean
  division: string | null
  emoji: string | null
}

export interface TeamTemplateSummary {
  id: string
  name: string
  description: string
  icon: string
  shape: 'linear' | 'fan-out' | 'parallel-head'
  /** parallel-head：从 Start 并行扇出的头部成员数。 */
  parallelCount?: number
  /** 运行输入引导：创建前就知道要准备什么输入。 */
  inputHint?: string
  /** 输入示例。 */
  inputExample?: string
  members: TeamTemplateMember[]
}

export interface TeamInstantiateResult {
  flowId: string
  templateId: string
  profile: PersonaProfile
  members: { persona: string; libraryId: string; agentId: string; enabled: boolean }[]
}

export async function fetchTeamTemplates(): Promise<TeamTemplateSummary[]> {
  const data = await apiFetch<{ templates: TeamTemplateSummary[] }>(
    '/api/agent-library/team-templates',
    undefined,
    '加载团队场景',
  )
  return data.templates
}

export async function instantiateTeamTemplate(
  id: string,
  req: { profile?: PersonaProfile; flowName?: string } = {},
): Promise<TeamInstantiateResult> {
  return apiFetch(
    `/api/agent-library/team-templates/${encodeURIComponent(id)}/instantiate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: req.profile, flow_name: req.flowName }),
    },
    '创建团队工作流',
  )
}
