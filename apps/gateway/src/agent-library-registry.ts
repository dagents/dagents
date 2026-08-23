/**
 * agent-library-registry.ts — Agent 人格库的运行时目录（registry-not-database）。
 *
 * `docs/agent-library.md` D1（库/目录分离）：agency-agents 这类人格资产库
 * （数百个 Markdown 专家人格）住文件系统，agents 表只装用户「启用」的行。
 * 于是 `@workflow` 生成的全量 agent 清单注入天然只含已启用项 —— 结构上
 * 消解清单爆炸，无需 schema 变更。骨架（roots 排序去重 / TTL 缓存 /
 * warn-and-skip）与 `skills-registry.ts` 同构，但发现规则不同：
 *
 *   <root>/divisions.json        部门元数据（label/icon/color）+ 合法 division 集
 *   <root>/<division>/（可嵌套）下所有 .md    人格文件（如 game-development/unity/）
 *
 * divisions.json 存在时只扫描其中列出的 division 目录（agency-agents 的
 * integrations/ examples/ scripts/ strategy/ 等 NON_DIVISION 目录自动排除）；
 * 缺失时退化为「根下所有一级子目录都是 division」，排除知名杂项目录。
 *
 * 人格寻址用 `<division>/<slug>`（如 `product/product-manager`）：frontmatter
 * name 自由大小写且跨部门可能撞名，slug 化 + 部门前缀保证稳定且可读，
 * 同时与 agency-agents 的文件命名习惯一致。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@dagents/shared'
import {
  parsePersonaMarkdown,
  sha256Hex,
  slugifyPersonaName,
} from './persona-compiler.js'
import {
  expandAgentLibraryHome,
  managedAgentLibraryDirs,
} from './managed-agent-library-dirs.js'

const log = createLogger({ svc: 'gateway:agent-library' })

const CATALOG_TTL_MS = 60_000
export const CUSTOM_ROOT_RANK_BASE = 300
export const MANAGED_ROOT_RANK_BASE = 400
export const DEFAULT_ROOT_RANK = 500
/** 嵌套扫描深度上限（division/unity/unity-architect.md 需要 2 层）。 */
const MAX_WALK_DEPTH = 3
/** divisions.json 缺失时的兜底排除清单（agency-agents 的非 division 目录）。 */
const NON_DIVISION_DIRS = new Set([
  'integrations', 'examples', 'scripts', 'strategy', 'docs', '.github', '.git', 'node_modules',
])

export interface AgentLibraryRoot {
  source: 'custom' | 'managed' | 'default'
  dir: string
  rank: number
}

export interface AgentLibraryEntrySummary {
  /** 稳定寻址 id：`<division>/<slug>`。 */
  id: string
  division: string
  /** frontmatter 展示名（如 "Product Manager"）。 */
  name: string
  description: string
  emoji: string | null
  color: string | null
  vibe: string | null
  /** frontmatter tools 声明（仅展示标注，不映射执行配置 —— 见设计 D2）。 */
  tools: string[] | null
  /** frontmatter kind/model 建议（快速开始档位人格用）：instantiate 的默认值。 */
  suggestedKind: string | null
  suggestedModel: string | null
  /** 文件字节数（前端据此提示 token 量级）。 */
  sizeBytes: number
}

/** `get(id)` 的完整载荷 —— 正文每次从磁盘新读，编辑立即可见。 */
export interface AgentLibraryEntry extends AgentLibraryEntrySummary {
  /** 去 frontmatter 的 markdown 正文。 */
  body: string
  /** 绝对文件路径（溯源展示）。 */
  filePath: string
  /** 全文（含 frontmatter）sha256 —— drift 判定的上游指纹。 */
  rawSha256: string
}

export interface AgentLibraryDivision {
  key: string
  label: string
  color: string | null
  /** Lucide 图标名（divisions.json 提供，仅展示）。 */
  icon: string | null
}

interface ScannedEntry extends AgentLibraryEntry {
  rootRank: number
}

/** 内置快速开始库根（agent-templates 退役承接，5 个运行时档位人格）。
 *  以本模块相对路径定位 —— dev（tsx 直跑 src）与构建产物均指向
 *  apps/gateway/quickstart-library；目录缺失时静默跳过。 */
const BUILTIN_QUICKSTART_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'quickstart-library')
const BUILTIN_QUICKSTART_RANK = 50

/** Resolve discovery roots. Evaluated per scan so env changes apply on refresh. */
export function defaultAgentLibraryRoots(): AgentLibraryRoot[] {
  const roots: AgentLibraryRoot[] = []
  const seen = new Set<string>()
  if (isReadableDir(BUILTIN_QUICKSTART_DIR)) {
    roots.push({ source: 'custom', dir: BUILTIN_QUICKSTART_DIR, rank: BUILTIN_QUICKSTART_RANK })
    seen.add(BUILTIN_QUICKSTART_DIR)
  }
  const custom = process.env.DAGENTS_AGENT_LIBRARY_DIRS
  if (custom) {
    custom
      .split(':')
      .map((d) => d.trim())
      .filter(Boolean)
      .forEach((dir, i) => {
        const expanded = expandAgentLibraryHome(dir)
        roots.push({ source: 'custom', dir: expanded, rank: CUSTOM_ROOT_RANK_BASE + i })
        seen.add(expanded)
      })
  }
  managedAgentLibraryDirs
    .list()
    .filter((dir) => !seen.has(dir))
    .forEach((dir, i) => {
      roots.push({ source: 'managed', dir, rank: MANAGED_ROOT_RANK_BASE + i })
    })
  const defaultDir = join(homedir(), '.agents', 'agent-library')
  if (!seen.has(defaultDir)) {
    roots.push({ source: 'default', dir: defaultDir, rank: DEFAULT_ROOT_RANK })
  }
  return roots
}

function isReadableDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function isReadableFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 读 divisions.json；缺失/损坏 → null（调用方退化为扫描全部一级子目录）。 */
function readDivisionsMeta(rootDir: string): Map<string, AgentLibraryDivision> | null {
  const file = join(rootDir, 'divisions.json')
  if (!isReadableFile(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      divisions?: Record<string, { label?: unknown; color?: unknown; icon?: unknown }>
    }
    if (!parsed.divisions || typeof parsed.divisions !== 'object') return null
    const map = new Map<string, AgentLibraryDivision>()
    for (const [key, meta] of Object.entries(parsed.divisions)) {
      map.set(key, {
        key,
        label: typeof meta?.label === 'string' ? meta.label : key,
        color: typeof meta?.color === 'string' ? meta.color : null,
        icon: typeof meta?.icon === 'string' ? meta.icon : null,
      })
    }
    return map
  } catch (err) {
    log.warn(`divisions.json unreadable at ${rootDir}: ${String(err)}`)
    return null
  }
}

/** 递归收集 dir 下所有 .md 文件（相对路径），深度封顶。 */
function walkMarkdownFiles(dir: string, depth = 0, prefix = ''): string[] {
  if (depth > MAX_WALK_DEPTH) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    log.warn(`agent library dir unreadable ${dir}: ${String(err)}`)
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(join(prefix, entry.name))
    } else if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(join(dir, entry.name), depth + 1, join(prefix, entry.name)))
    }
  }
  return files
}

function toStringArray(v: unknown): string[] | null {
  if (typeof v !== 'string' || !v.trim()) return null
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

function scanRoot(root: AgentLibraryRoot, divisions: Map<string, AgentLibraryDivision>): ScannedEntry[] {
  if (!isReadableDir(root.dir)) return []
  const meta = readDivisionsMeta(root.dir)
  const divisionKeys = meta
    ? [...meta.keys()].filter((k) => isReadableDir(join(root.dir, k)))
    : readdirSync(root.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NON_DIVISION_DIRS.has(e.name))
        .map((e) => e.name)

  const found: ScannedEntry[] = []
  for (const division of divisionKeys) {
    const metaEntry = meta?.get(division)
    if (metaEntry) divisions.set(division, metaEntry)
    else if (!divisions.has(division)) {
      divisions.set(division, { key: division, label: division, color: null, icon: null })
    }
    const divisionDir = join(root.dir, division)
    for (const relFile of walkMarkdownFiles(divisionDir)) {
      const file = join(divisionDir, relFile)
      let raw: string
      try {
        raw = readFileSync(file, 'utf-8')
      } catch (err) {
        log.warn(`agent library file unreadable ${file}: ${String(err)}`)
        continue
      }
      const parsed = parsePersonaMarkdown(raw)
      if (!parsed) {
        log.warn(`agent library file ignored (missing/invalid frontmatter): ${file}`)
        continue
      }
      const md = parsed.metadata ?? {}
      found.push({
        id: `${division}/${slugifyPersonaName(parsed.name)}`,
        division,
        name: parsed.name,
        description: parsed.description,
        emoji: typeof md.emoji === 'string' && md.emoji ? md.emoji : null,
        color: typeof md.color === 'string' && md.color ? md.color : null,
        vibe: typeof md.vibe === 'string' && md.vibe ? md.vibe : null,
        tools: toStringArray(md.tools),
        suggestedKind: typeof md.kind === 'string' && md.kind ? md.kind : null,
        suggestedModel: typeof md.model === 'string' && md.model ? md.model : null,
        sizeBytes: Buffer.byteLength(raw, 'utf-8'),
        body: parsed.body,
        filePath: file,
        rawSha256: sha256Hex(raw),
        rootRank: root.rank,
      })
    }
  }
  return found
}

export class AgentLibraryRegistry {
  private rootsProvider: () => AgentLibraryRoot[]
  private cached: AgentLibraryEntrySummary[] | null = null
  private cachedDivisions: AgentLibraryDivision[] | null = null
  private cachedAt = 0

  constructor(rootsProvider: () => AgentLibraryRoot[] = defaultAgentLibraryRoots) {
    this.rootsProvider = rootsProvider
  }

  private scanAll(): { entries: ScannedEntry[]; divisions: Map<string, AgentLibraryDivision> } {
    const divisions = new Map<string, AgentLibraryDivision>()
    const byId = new Map<string, ScannedEntry>()
    for (const root of this.rootsProvider()) {
      for (const entry of scanRoot(root, divisions)) {
        const existing = byId.get(entry.id)
        if (existing && existing.rootRank <= entry.rootRank) {
          log.warn(`duplicate agent library id "${entry.id}": root ${root.dir} ignored in favor of lower-rank root`)
          continue
        }
        byId.set(entry.id, entry)
      }
    }
    const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    return { entries, divisions }
  }

  private ensureFresh(): void {
    const now = Date.now()
    if (this.cached && this.cachedDivisions && now - this.cachedAt < CATALOG_TTL_MS) return
    const { entries, divisions } = this.scanAll()
    this.cached = entries.map(({ id, division, name, description, emoji, color, vibe, tools, suggestedKind, suggestedModel, sizeBytes }) => ({
      id, division, name, description, emoji, color, vibe, tools, suggestedKind, suggestedModel, sizeBytes,
    }))
    this.cachedDivisions = [...divisions.values()].sort((a, b) => a.key.localeCompare(b.key))
    this.cachedAt = now
  }

  /** 摘要目录（无正文），按 id 排序。`refresh: true` 强制重扫。 */
  list(opts: { refresh?: boolean } = {}): AgentLibraryEntrySummary[] {
    if (opts.refresh) {
      this.cached = null
      this.cachedDivisions = null
    }
    this.ensureFresh()
    return this.cached ?? []
  }

  /** 部门元数据（label/color/icon），按 key 排序。 */
  divisions(opts: { refresh?: boolean } = {}): AgentLibraryDivision[] {
    if (opts.refresh) {
      this.cached = null
      this.cachedDivisions = null
    }
    this.ensureFresh()
    return this.cachedDivisions ?? []
  }

  /** 单条完整定义（含正文，从磁盘新读）。找不到 → undefined。 */
  get(id: string): AgentLibraryEntry | undefined {
    const { entries } = this.scanAll()
    return entries.find((e) => e.id === id)
  }

  /**
   * 全量完整定义（单次扫描）—— 团队模板批量解析用：按 name 解析 N 个人格
   * 只付一次扫描成本（get() 每调一次都重扫，N 连调是 N 次全量读盘）。
   */
  getAll(): AgentLibraryEntry[] {
    return this.scanAll().entries
  }

  /** Currently configured discovery roots (for API surface/UI footer). */
  roots(): AgentLibraryRoot[] {
    return this.rootsProvider()
  }
}

/** Process-wide singleton used by the HTTP routes. */
export const agentLibraryRegistry = new AgentLibraryRegistry()
