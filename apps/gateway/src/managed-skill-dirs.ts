/**
 * managed-skill-dirs.ts — UI-managed custom skill directories.
 *
 * 让「自定义目录」可以在 console 里直接输入添加（而不是教用户改 .env）：
 * 目录列表持久化在用户级配置 `~/.agents/skill-dirs.json`（`{ "dirs": [...] }`，
 * 与 ~/.agents/skills 同一家目录），gateway 启动时读入、添加/移除即时写回。
 * 添加后由调用方（路由）强制 refresh 重扫，无需重启进程。
 *
 * 与 `DAGENTS_SKILL_DIRS` 环境变量的关系：env 是运维级配置（rank 300+，
 * 优先级更高），本模块是 UI 级配置（rank 400+）；同一展开路径不会重复
 * 注册，env 里已有的目录在界面上标记为不可移除。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:managed-skill-dirs' })

/** UI 管理的目录数上限 —— 防止误操作/自动化把扫描面无限扩大。 */
export const MAX_MANAGED_SKILL_DIRS = 16

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export interface SkillDirMutationResult {
  ok: boolean
  error?: string
  /** 展开后的绝对路径（ok 时必有）。 */
  dir?: string
}

/**
 * File-backed managed dir list. `file` is injectable so tests can point it
 * at a tmpdir; the exported singleton uses the user-level path.
 */
export class ManagedSkillDirs {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** Expanded, persisted dirs. Missing/corrupt file → [] (warn, never throw). */
  list(): string[] {
    if (!existsSync(this.file)) return []
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf-8')
    } catch (err) {
      log.warn(`managed skill dirs unreadable: ${this.err(err)}`)
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { dirs?: unknown }
      if (!Array.isArray(parsed.dirs)) return []
      return parsed.dirs
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => expandHome(d.trim()))
    } catch {
      log.warn('managed skill dirs file is not valid JSON — ignored')
      return []
    }
  }

  /** Validate + persist a new dir. Idempotence is an error (caller surfaces it). */
  add(input: string): SkillDirMutationResult {
    const dir = expandHome(input.trim())
    if (!input.trim() || !dir) return { ok: false, error: '目录不能为空' }
    if (!this.isDirectory(dir)) {
      return { ok: false, error: `目录不存在或不可读：${dir}` }
    }
    const dirs = this.list()
    if (dirs.includes(dir)) {
      return { ok: false, error: `目录已在列表中：${dir}` }
    }
    if (dirs.length >= MAX_MANAGED_SKILL_DIRS) {
      return { ok: false, error: `自定义目录已达上限（${MAX_MANAGED_SKILL_DIRS}）` }
    }
    dirs.push(dir)
    if (!this.persist(dirs)) return { ok: false, error: '写入配置文件失败（见网关日志）' }
    return { ok: true, dir }
  }

  /** Remove a persisted dir (expanded input must match). */
  remove(input: string): SkillDirMutationResult {
    const dir = expandHome(input.trim())
    const dirs = this.list()
    const next = dirs.filter((d) => d !== dir)
    if (next.length === dirs.length) {
      return { ok: false, error: `目录不在 UI 管理列表中：${dir}（环境变量配置的目录请改 DAGENTS_SKILL_DIRS）` }
    }
    if (!this.persist(next)) return { ok: false, error: '写入配置文件失败（见网关日志）' }
    return { ok: true, dir }
  }

  private isDirectory(dir: string): boolean {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  private persist(dirs: string[]): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify({ dirs }, null, 2)}\n`)
      return true
    } catch (err) {
      log.error(`persist managed skill dirs failed: ${this.err(err)}`)
      return false
    }
  }

  private err(err: unknown): string {
    return String(err)
  }
}

/** Process-wide singleton: `~/.agents/skill-dirs.json`. */
export const managedSkillDirs = new ManagedSkillDirs(join(homedir(), '.agents', 'skill-dirs.json'))
