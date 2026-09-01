/**
 * agent-library.ts — Agent 人格库的 console API client。
 *
 * 镜像 `agent-templates.ts` 的 unwrap 模式：所有调用打 console 代理
 * `/api/agent-library/*`（转发到 gateway `/api/v1/agent-library/*`）。
 * 人格寻址键是 `<division>/<slug>`（gateway 由 frontmatter name slug 化）。
 */

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
  | 'up-to-date'
  | 'upstream-updated'
  | 'locally-modified'
  | 'diverged'
  | 'missing-upstream'

export interface AgentLibraryDriftItem {
  agentId: string
  libraryId: string
  name: string
  division: string | null
  state: PersonaDriftState
  currentProfile: PersonaProfile | null
}

interface Envelope<T> {
  success?: boolean
  data?: T
  error?: string
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label}（HTTP ${res.status}）${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json().catch(() => null)) as Envelope<T> | null
  if (!body || !body.success || body.data === undefined) {
    throw new Error(body?.error ?? `${label}：未知错误`)
  }
  return body.data
}

function splitId(id: string): { division: string; slug: string } {
  const idx = id.indexOf('/')
  if (idx <= 0 || idx === id.length - 1) throw new Error(`非法的库 id：${id}`)
  return { division: id.slice(0, idx), slug: id.slice(idx + 1) }
}

export async function fetchAgentLibrary(opts: { division?: string; refresh?: boolean } = {}): Promise<AgentLibraryCatalog> {
  const qs = new URLSearchParams()
  if (opts.division) qs.set('division', opts.division)
  if (opts.refresh) qs.set('refresh', 'true')
  const query = qs.toString()
  const res = await fetch(`/api/agent-library${query ? `?${query}` : ''}`, { cache: 'no-store' })
  return unwrap<AgentLibraryCatalog>(res, '加载人格库失败')
}

export async function fetchAgentLibraryEntry(id: string): Promise<AgentLibraryDetail> {
  const { division, slug } = splitId(id)
  const res = await fetch(`/api/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  })
  return unwrap<AgentLibraryDetail>(res, '加载人格详情失败')
}

export async function fetchAgentLibraryDrift(): Promise<AgentLibraryDriftItem[]> {
  const res = await fetch('/api/agent-library/drift', { cache: 'no-store' })
  const data = await unwrap<{ items: AgentLibraryDriftItem[] }>(res, '加载同步状态失败')
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
  const res = await fetch(
    `/api/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}/instantiate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    },
  )
  return unwrap(res, '启用人格失败')
}

export async function reimportAgentFromLibrary(
  id: string,
  req: { confirm?: boolean; profile?: PersonaProfile } = {},
): Promise<{ id: string; profile: PersonaProfile; fromState: PersonaDriftState }> {
  const { division, slug } = splitId(id)
  const res = await fetch(
    `/api/agent-library/${encodeURIComponent(division)}/${encodeURIComponent(slug)}/reimport`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    },
  )
  return unwrap(res, '重新导入失败')
}

export async function addAgentLibraryRoot(dir: string): Promise<{ dir: string }> {
  const res = await fetch('/api/agent-library/roots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  })
  return unwrap(res, '添加挂载目录失败')
}

export async function removeAgentLibraryRoot(dir: string): Promise<{ dir: string }> {
  const res = await fetch(`/api/agent-library/roots?dir=${encodeURIComponent(dir)}`, {
    method: 'DELETE',
  })
  return unwrap(res, '移除挂载目录失败')
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
  const res = await fetch('/api/agent-library/team-templates', { cache: 'no-store' })
  const data = await unwrap<{ templates: TeamTemplateSummary[] }>(res, '加载团队场景失败')
  return data.templates
}

export async function instantiateTeamTemplate(
  id: string,
  req: { profile?: PersonaProfile; flowName?: string } = {},
): Promise<TeamInstantiateResult> {
  const res = await fetch(`/api/agent-library/team-templates/${encodeURIComponent(id)}/instantiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: req.profile, flow_name: req.flowName }),
  })
  return unwrap(res, '创建团队工作流失败')
}
