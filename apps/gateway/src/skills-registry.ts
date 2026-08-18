/**
 * skills-registry.ts — runtime catalog of local agent skills.
 *
 * Registry-not-database design (modeled on deepseek-harness's skill family and
 * the cross-client `~/.agents/skills` convention shared by Cursor / Gemini CLI
 * / Copilot CLI): the filesystem IS the source of truth. Skills are discovered
 * on demand, summarized in an in-process TTL cache, and never written to
 * Postgres. Full bodies are re-read from disk on every `get()` so edits to a
 * SKILL.md are visible without any invalidation protocol.
 *
 * Discovery roots, in rank order (lower rank wins a duplicate name):
 *
 *   | Rank | Source       | Root                                    |
 *   |------|--------------|-----------------------------------------|
 *   | 300+ | custom (env) | `DAGENTS_SKILL_DIRS` (colon-separated)  |
 *   | 400+ | custom (ui)  | `~/.agents/skill-dirs.json` (managed)   |
 *   | 500  | user-agents  | `~/.agents/skills`                      |
 *
 * Accepted shapes per root (recursive nested discovery is NOT supported,
 * matching the dsh local provider):
 *   - directory bundle: `<name>/SKILL.md`
 *   - flat file:        `<name>.md`
 *
 * A skill must carry YAML frontmatter with kebab-case `name` and a non-empty
 * `description`; anything else is skipped with a warning (warn-and-skip, never
 * fails the whole scan). Extra frontmatter keys (e.g. `triggers`) are kept as
 * `metadata` on the detail payload.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, type YAMLParseError } from 'yaml'
import { createLogger } from '@dagents/shared'
import { expandHome, managedSkillDirs } from './managed-skill-dirs.js'

const log = createLogger({ svc: 'gateway:skills' })

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CATALOG_TTL_MS = 60_000
export const CUSTOM_ROOT_RANK_BASE = 300
export const MANAGED_ROOT_RANK_BASE = 400
export const USER_AGENTS_ROOT_RANK = 500

export interface SkillSummary {
  /** Kebab-case identifier used to address the skill. */
  name: string
  /** Routing description from frontmatter, whitespace-normalized. */
  description: string
  /** Which discovery root produced this skill ('custom' | 'user-agents'). */
  source: string
}

/** Complete skill definition returned by `get()` — body loaded fresh from disk. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body with the frontmatter block removed. */
  content: string
  /** Absolute directory holding the skill's resources (resourceBase). */
  dir: string
  /** Extra frontmatter keys beyond name/description, or null. */
  metadata: Record<string, unknown> | null
}

export interface SkillRoot {
  source: string
  dir: string
  rank: number
}

interface ScannedSkill extends SkillDefinition {
  rootRank: number
}

/** Resolve discovery roots. Evaluated per scan so env changes apply on refresh. */
export function defaultSkillRoots(): SkillRoot[] {
  const roots: SkillRoot[] = []
  const seen = new Set<string>()
  const custom = process.env.DAGENTS_SKILL_DIRS
  if (custom) {
    custom
      .split(':')
      .map((d) => d.trim())
      .filter(Boolean)
      .forEach((dir, i) => {
        const expanded = expandHome(dir)
        roots.push({ source: 'custom', dir: expanded, rank: CUSTOM_ROOT_RANK_BASE + i })
        seen.add(expanded)
      })
  }
  // UI-managed dirs (rank 400+). Env already covers a path → skip (env wins).
  managedSkillDirs
    .list()
    .filter((dir) => !seen.has(dir))
    .forEach((dir, i) => {
      roots.push({ source: 'custom', dir, rank: MANAGED_ROOT_RANK_BASE + i })
    })
  roots.push({
    source: 'user-agents',
    dir: join(homedir(), '.agents', 'skills'),
    rank: USER_AGENTS_ROOT_RANK,
  })
  return roots
}

/**
 * Split a raw SKILL.md into frontmatter data and the markdown body.
 * Returns null (and logs a warning) when the file is unusable — the caller
 * treats that as skip-this-skill, not scan-failure.
 */
function parseSkillFile(raw: string, displayPath: string):
  | { name: string; description: string; metadata: Record<string, unknown> | null; content: string }
  | null {
  const openFence = raw.match(/^---[ \t]*\r?\n/)
  if (!openFence) {
    log.warn(`skill file ${displayPath} ignored: missing YAML frontmatter`)
    return null
  }
  const bodyStart = raw.slice(openFence[0].length)
  // Closing fence: first standalone `---` line after the opening one.
  const closing = bodyStart.match(/^---[ \t]*$/m)
  if (!closing || closing.index === undefined) {
    log.warn(`skill file ${displayPath} ignored: missing YAML frontmatter`)
    return null
  }
  const yamlText = bodyStart.slice(0, closing.index)
  let data: unknown
  try {
    data = parseYaml(yamlText)
  } catch (err) {
    log.warn(`skill file ${displayPath} ignored: invalid YAML frontmatter: ${(err as YAMLParseError).message}`)
    return null
  }
  if (typeof data !== 'object' || data === null) {
    log.warn(`skill file ${displayPath} ignored: frontmatter requires name and description`)
    return null
  }
  const record = data as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  if (!KEBAB_CASE.test(name)) {
    log.warn(`skill file ${displayPath} ignored: frontmatter name must be kebab-case, got ${JSON.stringify(name)}`)
    return null
  }
  const description =
    typeof record.description === 'string' ? record.description.replace(/\s+/g, ' ').trim() : ''
  if (!description) {
    log.warn(`skill file ${displayPath} ignored: frontmatter requires name and description`)
    return null
  }
  const metadata: Record<string, unknown> = { ...record }
  delete metadata.name
  delete metadata.description
  const content = bodyStart.slice(closing.index + closing[0].length).replace(/^\r?\n/, '')
  return { name, description, metadata: Object.keys(metadata).length > 0 ? metadata : null, content }
}

function isReadableDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Scan one root and return its skills. Missing/unreadable root → empty. */
function scanRoot(root: SkillRoot): ScannedSkill[] {
  if (!isReadableDir(root.dir)) return []
  const found: ScannedSkill[] = []
  let entries
  try {
    entries = readdirSync(root.dir, { withFileTypes: true })
  } catch (err) {
    log.warn(`skill root ${root.dir} unreadable: ${(err as Error).message}`)
    return []
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    let file: string
    let dir: string
    if (entry.isDirectory()) {
      // Directory bundle: <name>/SKILL.md
      file = join(root.dir, entry.name, 'SKILL.md')
      dir = join(root.dir, entry.name)
      if (!isReadableFile(file)) continue
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Flat file: <name>.md
      file = join(root.dir, entry.name)
      dir = root.dir
    } else {
      continue
    }
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (err) {
      log.warn(`skill file ${file} unreadable: ${(err as Error).message}`)
      continue
    }
    const parsed = parseSkillFile(raw, file)
    if (!parsed) continue
    found.push({ ...parsed, source: root.source, dir, rootRank: root.rank })
  }
  return found
}

function isReadableFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export class SkillsRegistry {
  private rootsProvider: () => SkillRoot[]
  private cached: SkillSummary[] | null = null
  private cachedAt = 0

  constructor(rootsProvider: () => SkillRoot[] = defaultSkillRoots) {
    this.rootsProvider = rootsProvider
  }

  /**
   * Merged catalog, sorted by name. Duplicate names across roots resolve by
   * root rank (custom beats user); duplicates within one root are first-wins.
   * Cached in-process for 60s; `refresh: true` forces a rescan.
   */
  list(opts: { refresh?: boolean } = {}): SkillSummary[] {
    const now = Date.now()
    if (!opts.refresh && this.cached && now - this.cachedAt < CATALOG_TTL_MS) {
      return this.cached
    }
    this.cached = this.scanAll().map(({ name, description, source }) => ({ name, description, source }))
    this.cachedAt = now
    return this.cached
  }

  /**
   * Full definition for one skill. Always rescans and re-reads the file so a
   * body edit is visible on the next call (full definitions are never cached).
   */
  get(name: string): SkillDefinition | undefined {
    if (!KEBAB_CASE.test(name)) return undefined
    return this.scanAll().find((s) => s.name === name)
  }

  /** Currently configured discovery roots (for API surface/UI footer). */
  roots(): SkillRoot[] {
    return this.rootsProvider()
  }

  private scanAll(): ScannedSkill[] {
    const byName = new Map<string, ScannedSkill>()
    for (const root of this.rootsProvider()) {
      for (const skill of scanRoot(root)) {
        const existing = byName.get(skill.name)
        if (existing && existing.rootRank <= skill.rootRank) {
          log.warn(`duplicate skill name "${skill.name}": ${skill.source} root ignored in favor of lower-rank root`)
          continue
        }
        byName.set(skill.name, skill)
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Process-wide singleton used by the HTTP routes. */
export const skillsRegistry = new SkillsRegistry()
