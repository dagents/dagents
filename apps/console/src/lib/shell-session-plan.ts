/**
 * shell-session-plan.ts — 终端会话生命周期的纯决策层（无 DOM / 无网络）。
 *
 * 2026-09-19 P2 多标签重构：决策模型从「单会话恢复/新建/换仓」升级为
 * 「标签页 attach/recreate/fresh」。旧矩阵的全部教训都带到了新语义里：
 *   - 恢复优先不打扰活会话 → attach 只认活会话
 *   - 显式意图压过恢复偏好 → 深链/选择器先经 planOpenDir 解析成 tab 动作
 *   - 换仓双份逻辑分叉 → 目录入口只有一份 planOpenDir（同目录复用 tab，
 *     异目录新 tab —— 「入口爆炸后杀旧建新」的取舍由多标签消解）
 *
 * 决策输入（全部由调用方取好后传入）：
 *   - tabs / activeId：持久化的标签页（id = 服务端会话 id，dirId = 目录锚）
 *   - legacySessionId：旧版单会话 key（dagents.terminal.sessionId）—— 迁移期
 *     读作一个无目录锚的 tab
 *   - sessions：GET /api/shell 的活会话列表（网关真相，含已退出的残留行）
 *   - intentDirId：用户显式意图（?dir= 深链 boot 期一次性消费）
 *   - prefDirId：持久化目录偏好（fresh 落点 / 新 tab 默认目录）
 */

import type { ShellSessionSummary } from '@dagents/contracts'

export interface DirectoryLike {
  id: string
  path: string
}

/** 持久化形状（localStorage 只存这几个字段）。 */
export interface ShellTabState {
  /** 服务端会话 id。 */
  id: string
  /** 目录锚（null = 主目录）—— recreate 的落点与新 tab 的默认目录。 */
  dirId: string | null
  /** 展示标签（P4 交互式 agent 会话 = agent 名；shell 会话缺省）。 */
  label?: string
}

/** 目录 id → 绝对路径（目录表里已不存在 → undefined，回落主目录）。 */
export function resolveDirPath(directories: DirectoryLike[], dirId: string | null): string | undefined {
  if (!dirId) return undefined
  return directories.find((d) => d.id === dirId)?.path
}

/** 路径 → 目录 id（attach 时从会话 cwd 反解目录锚；匹配不上 → null）。 */
export function resolveDirId(directories: DirectoryLike[], cwd: string | null | undefined): string | null {
  if (!cwd) return null
  return directories.find((d) => d.path === cwd)?.id ?? null
}

/* ── 目录入口决策：同目录复用 tab，异目录新 tab ────────────────────────── */

export type OpenDirPlan =
  | { kind: 'activate'; tabId: string }
  | { kind: 'newTab'; dirId: string | null }

/** 深链 / 目录选择器的单一入口决策。target=null 表示主目录。 */
export function planOpenDir(input: { tabs: ShellTabState[]; target: string | null }): OpenDirPlan {
  const hit = input.tabs.find((tb) => tb.dirId === input.target)
  return hit ? { kind: 'activate', tabId: hit.id } : { kind: 'newTab', dirId: input.target }
}

/* ── boot 决策：活动 tab attach / recreate / 首个 fresh ─────────────────── */

export type TabsBootPlan =
  | { kind: 'attach'; tab: ShellTabState; session: ShellSessionSummary }
  | { kind: 'recreate'; tab: ShellTabState; cwd?: string }
  | { kind: 'fresh'; dirId: string | null; cwd?: string }

export interface TabsBootInput {
  tabs: ShellTabState[]
  activeId: string | null
  /** 旧版单会话 key（tabs 为空时读作迁移 tab）。 */
  legacySessionId: string | null
  sessions: ShellSessionSummary[]
  /** ?dir= 深链（boot 期一次性意图）；null = 无。 */
  intentDirId: string | null
  /** 持久化目录偏好（fresh 的落点）。 */
  prefDirId: string | null
  directories: DirectoryLike[]
}

export function planTabsBoot(input: TabsBootInput): TabsBootPlan {
  // 深链意图先解析成 tab 动作（同目录已有 tab → 激活；否则建新 tab 项）
  let tabs = input.tabs
  let activeId = input.activeId
  if (input.intentDirId !== null) {
    const open = planOpenDir({ tabs, target: input.intentDirId })
    if (open.kind === 'activate') {
      activeId = open.tabId
    } else {
      // 新 tab 项先落占位 id（会话未建）—— 由 fresh 分支建会话后回填
      tabs = [...tabs, { id: '__pending__', dirId: open.dirId }]
      activeId = '__pending__'
    }
  }

  // 迁移：tabs 空 + 旧版单会话 id 活着 → 读作一个无锚 tab
  if (tabs.length === 0 && input.legacySessionId) {
    const legacyAlive = input.sessions.find(
      (s) => s.id === input.legacySessionId && !s.exited,
    )
    if (legacyAlive) {
      tabs = [{ id: legacyAlive.id, dirId: resolveDirId(input.directories, legacyAlive.cwd) }]
      activeId = legacyAlive.id
    }
  }

  if (tabs.length === 0) {
    const dirId = input.intentDirId ?? input.prefDirId ?? null
    const cwd = resolveDirPath(input.directories, dirId)
    return { kind: 'fresh', dirId, ...(cwd ? { cwd } : {}) }
  }

  const active = tabs.find((tb) => tb.id === activeId) ?? tabs[0]
  if (active.id === '__pending__') {
    const cwd = resolveDirPath(input.directories, active.dirId)
    return { kind: 'fresh', dirId: active.dirId, ...(cwd ? { cwd } : {}) }
  }
  const alive = input.sessions.find((s) => s.id === active.id && !s.exited)
  if (alive) return { kind: 'attach', tab: active, session: alive }
  const cwd = resolveDirPath(input.directories, active.dirId)
  return { kind: 'recreate', tab: active, ...(cwd ? { cwd } : {}) }
}
