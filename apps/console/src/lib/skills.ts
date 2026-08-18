/**
 * skills.ts — client for the gateway's runtime skills registry.
 *
 * Skills are a filesystem-backed runtime catalog (`~/.agents/skills` +
 * `DAGENTS_SKILL_DIRS`, the cross-client convention shared by Cursor / Gemini
 * CLI / Copilot CLI) — never persisted as platform entities. These helpers
 * mirror the gateway DTOs from GET /api/v1/skills and /api/v1/skills/:name.
 */

export interface SkillSummary {
  /** Kebab-case identifier used to address the skill. */
  name: string
  /** Routing description from frontmatter, whitespace-normalized. */
  description: string
  /** Discovery root that produced this skill ('custom' | 'user-agents'). */
  source: string
}

export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body with the frontmatter block removed. */
  content: string
  /** Absolute directory holding the skill's resources. */
  dir: string
  /** Extra frontmatter keys beyond name/description, or null. */
  metadata: Record<string, unknown> | null
}

export interface SkillRootInfo {
  source: string
  dir: string
  rank: number
  /** true = UI 管理的目录（界面可删）；env 配置的为 false。 */
  removable?: boolean
}

/** 添加/移除自定义目录后的返回：一次往返带回最新目录与技能列表。 */
export interface SkillCatalog {
  skills: SkillSummary[]
  roots: SkillRootInfo[]
}

export function sourceLabel(source: string): string {
  if (source === 'user-agents') return '本机 ~/.agents'
  if (source === 'custom') return '自定义目录'
  return source
}

interface Envelope<T> {
  success: boolean
  error?: string
  data?: T
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

/** Fetch the merged skill catalog. `refresh` bypasses the gateway's 60s cache. */
export async function fetchSkills(refresh = false): Promise<SkillCatalog> {
  return unwrap(
    await fetch(`/api/skills${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' }),
    'skills list',
  )
}

/** Fetch one full skill definition (body re-read from disk on the gateway). */
export async function fetchSkillDetail(name: string): Promise<SkillDefinition> {
  return unwrap(
    await fetch(`/api/skills/${encodeURIComponent(name)}`, { cache: 'no-store' }),
    'skill detail',
  )
}

/**
 * 添加一个自定义技能目录（网关校验存在性、持久化到 ~/.agents/skill-dirs.json
 * 并强制重扫）。返回更新后的目录 + 技能列表。
 */
export async function addSkillRoot(dir: string): Promise<SkillCatalog> {
  return unwrap(
    await fetch('/api/skills/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    }),
    'add skill root',
  )
}

/** 移除一个 UI 管理的自定义目录（env 配置的目录不可移除）。 */
export async function removeSkillRoot(dir: string): Promise<SkillCatalog> {
  return unwrap(
    await fetch(`/api/skills/roots?dir=${encodeURIComponent(dir)}`, {
      method: 'DELETE',
    }),
    'remove skill root',
  )
}
