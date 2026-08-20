/**
 * managed-agent-library-dirs.ts — UI 管理的 Agent 库挂载目录。
 *
 * 与 `managed-skill-dirs.ts` 同构（Agent Library 设计 D1：库/目录分离，
 * 文件系统即真相源）：目录列表持久化在 `~/.agents/agent-library-dirs.json`
 * （`{ "dirs": [...] }`），gateway 读取、增删即时写回，调用方（路由）
 * 强制 refresh 重扫。典型挂载对象是 agency-agents 的 git clone —— 上游
 * 同步就是 `git pull`，注册表 TTL 缓存自动看见。
 *
 * 与 `DAGENTS_AGENT_LIBRARY_DIRS` 环境变量的关系：env 是运维级配置
 * （rank 300+，优先级更高），本模块是 UI 级配置（rank 400+）；默认根
 * `~/.agents/agent-library`（rank 500，软链到任意人格库即可开箱可用）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '@dagents/shared'

const log = createLogger({ svc: 'gateway:managed-agent-library-dirs' })

/** UI 管理的目录数上限 —— 防止误操作/自动化把扫描面无限扩大。 */
export const MAX_MANAGED_AGENT_LIBRARY_DIRS = 16

export interface AgentLibraryDirMutationResult {
  ok: boolean
  error?: string
  /** 展开后的绝对路径（ok 时必有）。 */
  dir?: string
}

export function expandAgentLibraryHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** File-backed managed dir list. `file` 可注入，测试指向 tmpdir。 */
export class ManagedAgentLibraryDirs {
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
      log.warn(`managed agent library dirs unreadable: ${String(err)}`)
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { dirs?: unknown }
      if (!Array.isArray(parsed.dirs)) return []
      return parsed.dirs
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => expandAgentLibraryHome(d.trim()))
    } catch {
      log.warn('managed agent library dirs file is not valid JSON — ignored')
      return []
    }
  }

  /** Validate + persist a new dir. Idempotence is an error (caller surfaces it). */
  add(input: string): AgentLibraryDirMutationResult {
    const dir = expandAgentLibraryHome(input.trim())
    if (!input.trim() || !dir) return { ok: false, error: '目录不能为空' }
    if (!this.isDirectory(dir)) {
      return { ok: false, error: `目录不存在或不可读：${dir}` }
    }
    const dirs = this.list()
    if (dirs.includes(dir)) {
      return { ok: false, error: `目录已在列表中：${dir}` }
    }
    if (dirs.length >= MAX_MANAGED_AGENT_LIBRARY_DIRS) {
      return { ok: false, error: `挂载目录已达上限（${MAX_MANAGED_AGENT_LIBRARY_DIRS}）` }
    }
    dirs.push(dir)
    if (!this.persist(dirs)) return { ok: false, error: '写入配置文件失败（见网关日志）' }
    return { ok: true, dir }
  }

  /** Remove a persisted dir (expanded input must match). */
  remove(input: string): AgentLibraryDirMutationResult {
    const dir = expandAgentLibraryHome(input.trim())
    const dirs = this.list()
    const next = dirs.filter((d) => d !== dir)
    if (next.length === dirs.length) {
      return {
        ok: false,
        error: `目录不在挂载列表中：${dir}（环境变量配置的目录请改 DAGENTS_AGENT_LIBRARY_DIRS）`,
      }
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
      log.error(`persist managed agent library dirs failed: ${String(err)}`)
      return false
    }
  }
}

/** Process-wide singleton: `~/.agents/agent-library-dirs.json`. */
export const managedAgentLibraryDirs = new ManagedAgentLibraryDirs(
  join(homedir(), '.agents', 'agent-library-dirs.json'),
)
