import { describe, it, expect } from 'vitest'
import {
  planOpenDir,
  planTabsBoot,
  resolveDirId,
  resolveDirPath,
  type ShellTabState,
} from '@/lib/shell-session-plan'
import type { ShellSessionSummary } from '@dagents/contracts'

/** 多标签决策层（P2，2026-09-19）行为矩阵 —— 纯函数无 DOM/网络。 */

const DIRS = [
  { id: 'd-proj', path: '/Users/x/Projects/proj' },
  { id: 'd-other', path: '/Users/x/other' },
]

const session = (id: string, cwd: string | null, exited = false): ShellSessionSummary => ({
  id,
  cwd: cwd ?? '',
  exited,
  createdAt: 0,
})

const tab = (id: string, dirId: string | null): ShellTabState => ({ id, dirId })

describe('planOpenDir（目录入口：同目录复用 tab）', () => {
  it('目标目录已有 tab → activate（不打扰、不另开）', () => {
    const tabs = [tab('s1', null), tab('s2', 'd-proj')]
    expect(planOpenDir({ tabs, target: 'd-proj' })).toEqual({ kind: 'activate', tabId: 's2' })
  })

  it('主目录（null）也有复用语义', () => {
    const tabs = [tab('s1', null), tab('s2', 'd-proj')]
    expect(planOpenDir({ tabs, target: null })).toEqual({ kind: 'activate', tabId: 's1' })
  })

  it('无匹配 tab → newTab（异目录新开）', () => {
    const tabs = [tab('s1', 'd-proj')]
    expect(planOpenDir({ tabs, target: 'd-other' })).toEqual({ kind: 'newTab', dirId: 'd-other' })
  })

  it('无 tabs → newTab', () => {
    expect(planOpenDir({ tabs: [], target: null })).toEqual({ kind: 'newTab', dirId: null })
  })
})

describe('planTabsBoot（boot 决策）', () => {
  it('活动 tab 的会话活着 → attach（恢复优先不打扰）', () => {
    const tabs = [tab('s1', 'd-proj'), tab('s2', null)]
    const plan = planTabsBoot({
      tabs,
      activeId: 's1',
      legacySessionId: null,
      sessions: [session('s1', '/Users/x/Projects/proj')],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan.kind).toBe('attach')
    if (plan.kind === 'attach') {
      expect(plan.tab.id).toBe('s1')
      expect(plan.session.id).toBe('s1')
    }
  })

  it('活动 tab 会话已死 → recreate（tab 身份不变，同目录重建）', () => {
    const plan = planTabsBoot({
      tabs: [tab('s-dead', 'd-proj')],
      activeId: 's-dead',
      legacySessionId: null,
      sessions: [],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan).toEqual({
      kind: 'recreate',
      tab: tab('s-dead', 'd-proj'),
      cwd: '/Users/x/Projects/proj',
    })
  })

  it('列表里的已退出残留会话不算活 → recreate', () => {
    const plan = planTabsBoot({
      tabs: [tab('s-ex', 'd-proj')],
      activeId: 's-ex',
      legacySessionId: null,
      sessions: [session('s-ex', '/Users/x/Projects/proj', true)],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan.kind).toBe('recreate')
  })

  it('activeId 失效（指向不存在的 tab）→ 回落第一个 tab', () => {
    const plan = planTabsBoot({
      tabs: [tab('s1', null)],
      activeId: 's-gone',
      legacySessionId: null,
      sessions: [session('s1', '/home/x')],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan.kind).toBe('attach')
  })

  it('目录锚解析失败（目录已注销）→ recreate 落主目录', () => {
    const plan = planTabsBoot({
      tabs: [tab('s1', 'd-gone')],
      activeId: 's1',
      legacySessionId: null,
      sessions: [],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan).toEqual({ kind: 'recreate', tab: tab('s1', 'd-gone') })
  })

  it('tabs 空 + 旧版单会话 id 活着 → 迁移读作 tab（cwd 反解目录锚）', () => {
    const plan = planTabsBoot({
      tabs: [],
      activeId: null,
      legacySessionId: 's-legacy',
      sessions: [session('s-legacy', '/Users/x/Projects/proj')],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan.kind).toBe('attach')
    if (plan.kind === 'attach') expect(plan.tab.dirId).toBe('d-proj')
  })

  it('tabs 空 + 无 legacy → fresh 按目录偏好落点', () => {
    const plan = planTabsBoot({
      tabs: [],
      activeId: null,
      legacySessionId: null,
      sessions: [],
      intentDirId: null,
      prefDirId: 'd-other',
      directories: DIRS,
    })
    expect(plan).toEqual({ kind: 'fresh', dirId: 'd-other', cwd: '/Users/x/other' })
  })

  it('深链意图命中已有同目录 tab → 激活它并 attach', () => {
    const plan = planTabsBoot({
      tabs: [tab('s1', null), tab('s2', 'd-proj')],
      activeId: 's1',
      legacySessionId: null,
      sessions: [session('s1', '/home/x'), session('s2', '/Users/x/Projects/proj')],
      intentDirId: 'd-proj',
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan.kind).toBe('attach')
    if (plan.kind === 'attach') expect(plan.tab.id).toBe('s2')
  })

  it('深链意图无同目录 tab → fresh 在意图目录建新 tab', () => {
    const plan = planTabsBoot({
      tabs: [tab('s1', null)],
      activeId: 's1',
      legacySessionId: null,
      sessions: [session('s1', '/home/x')],
      intentDirId: 'd-other',
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan).toEqual({ kind: 'fresh', dirId: 'd-other', cwd: '/Users/x/other' })
  })

  it('fresh 无偏好无意图 → 主目录', () => {
    const plan = planTabsBoot({
      tabs: [],
      activeId: null,
      legacySessionId: null,
      sessions: [],
      intentDirId: null,
      prefDirId: null,
      directories: DIRS,
    })
    expect(plan).toEqual({ kind: 'fresh', dirId: null })
  })
})

describe('目录锚反解', () => {
  it('cwd 精确匹配目录路径 → 该目录 id', () => {
    expect(resolveDirId(DIRS, '/Users/x/Projects/proj')).toBe('d-proj')
  })

  it('cwd 不匹配（网关 cwd / 未注册路径）→ null（诚实：不猜锚）', () => {
    expect(resolveDirId(DIRS, '/etc')).toBeNull()
    expect(resolveDirId(DIRS, null)).toBeNull()
  })

  it('resolveDirPath：id → 路径；注销/未知 → undefined', () => {
    expect(resolveDirPath(DIRS, 'd-proj')).toBe('/Users/x/Projects/proj')
    expect(resolveDirPath(DIRS, null)).toBeUndefined()
    expect(resolveDirPath(DIRS, 'd-gone')).toBeUndefined()
  })
})
