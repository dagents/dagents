/**
 * 文件黑板（File Blackboard）—— 本地文件作为多 agent 共享知识的运行时层。
 *
 * 约定（docs/team-collaboration-ui-research.md 方向 B，2026-11-10）：
 * 项目目录（run 的 directoryId 解析出的 cwd）下的 `.agents/` 是团队的
 * 共享知识树：
 *
 *   .agents/
 *     BOARD.md      任务板：目标 + 任务行（谁认领/什么状态）—— kanban 的文件形态
 *     knowledge/    沉淀的知识条目（调研结论、决策记录）—— 跨 run 复用
 *     handoff/      交接条目：fan-out 分支结束时各写一份，汇总节点/下一轮读取
 *
 * 三层支撑里的两层在这：
 *  - 注入层：`buildBlackboardContext` 产出注入 LLM/Agent 节点 system 前部的
 *    上下文块（workflow-engine-service 装配时拼接进 flowContext）；
 *  - 观察层：`readBlackboardSnapshot` 产出界面黑板面板的完整快照
 *    （directories 路由 `GET /:id/blackboard`）。
 *
 * 书写层不需要代码：CLI agent 在 cwd 写文件是天然能力，人格/团队模板的
 * 步骤指令里写明黑板纪律即可。
 *
 * registry-not-database 同构：文件系统是真相源，本模块只读 + mtime 缓存，
 * 不建表、不写库。读取全部 try/catch 降级 —— 黑板是增益不是依赖，任何
 * 故障（目录不存在/权限/超大文件）都不阻塞执行，只少了上下文。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 黑板根目录名（相对项目目录）。 */
export const BLACKBOARD_DIR = '.agents'

/** 注入块里 BOARD.md 的字符子预算（默认 4KB，`DAGENTS_BOARD_CONTEXT_CAP` 可调）。 */
export function BOARD_CONTEXT_CAP(): number {
  const raw = Number(process.env.DAGENTS_BOARD_CONTEXT_CAP)
  return Number.isFinite(raw) && raw > 0 ? raw : 4096
}

/** knowledge/handoff 清单各自最多列出的条目数（防目录爆炸撑爆注入块）。 */
const LISTING_LIMIT = 20

/** 单文件读取字节上限（BOARD.md 超限截断；列表文件只取名 + mtime，不读内容）。 */
const FILE_READ_CAP_BYTES = 64 * 1024

/** 黑板里的一个文件条目（列表用；内容按需另取）。 */
export interface BlackboardEntry {
  name: string
  /** 相对黑板根的路径（`knowledge/foo.md`）。 */
  relPath: string
  /** 最后修改时间（ISO；解析失败为 null，界面按无时间渲染）。 */
  mtime: string | null
  /** 字节数（目录异常时 0）。 */
  size: number
}

/** 一个目录的黑板快照（观察层 + 注入层的共同数据源）。 */
export interface BlackboardSnapshot {
  /** 黑板根绝对路径（目录不存在时为预期路径，`exists=false`）。 */
  root: string
  exists: boolean
  boardMd: string | null
  boardMtime: string | null
  knowledge: BlackboardEntry[]
  handoff: BlackboardEntry[]
}

/** 目录条目读取（容错：任何一步失败返回空列表，不抛）。 */
function listEntries(root: string, sub: string): BlackboardEntry[] {
  const dir = join(root, sub)
  try {
    const names = readdirSync(dir)
    const entries: BlackboardEntry[] = []
    for (const name of names.slice(0, LISTING_LIMIT)) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        entries.push({
          name,
          relPath: `${sub}/${name}`,
          mtime: st.mtime.toISOString(),
          size: st.size,
        })
      } catch {
        // 单条目异常（权限等）跳过，不影响其余条目
      }
    }
    // 新写的在前（mtime 降序，无时间垫底）——「谁刚写了什么」是面板主叙事
    entries.sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? ''))
    return entries
  } catch {
    return []
  }
}

/** mtime 缓存键：黑板三块数据源的最后修改时间戳串。 */
function cacheKeyOf(root: string): string | null {
  try {
    const st = statSync(join(root, 'BOARD.md'))
    return `b${st.mtimeMs}`
  } catch {
    // BOARD.md 不存在时以 knowledge/handoff 目录 mtime 兜底拼键
    try {
      const k = statSync(join(root, 'knowledge')).mtimeMs
      const h = statSync(join(root, 'handoff')).mtimeMs
      return `d${k}:${h}`
    } catch {
      return null
    }
  }
}

/** 进程内快照缓存（key = root；黑板写入频繁度远低于执行装配，单槽足够）。 */
const snapshotCache = new Map<string, { key: string | null; snap: BlackboardSnapshot }>()

/**
 * 读一个项目目录的黑板快照（观察层主入口）。
 * 目录不存在 / 无黑板 → `exists:false` 的空快照（界面渲染引导态，不是错误）。
 */
export function readBlackboardSnapshot(projectRoot: string): BlackboardSnapshot {
  const root = join(projectRoot, BLACKBOARD_DIR)
  const key = cacheKeyOf(root)
  const cached = snapshotCache.get(projectRoot)
  if (cached && cached.key === key) return cached.snap

  const snap: BlackboardSnapshot = { root, exists: false, boardMd: null, boardMtime: null, knowledge: [], handoff: [] }
  if (key !== null || existsSync(root)) {
    snap.exists = true
    try {
      const buf = readFileSync(join(root, 'BOARD.md'))
      // 换行归一（Windows CRLF / 旧 Mac CR → LF）：任务行解析与界面渲染共用
      snap.boardMd = buf.subarray(0, FILE_READ_CAP_BYTES).toString('utf8').replace(/\r\n?/g, '\n')
    } catch {
      snap.boardMd = null
    }
    try {
      snap.boardMtime = statSync(join(root, 'BOARD.md')).mtime.toISOString()
    } catch {
      snap.boardMtime = null
    }
    snap.knowledge = listEntries(root, 'knowledge')
    snap.handoff = listEntries(root, 'handoff')
  }
  snapshotCache.set(projectRoot, { key, snap })
  return snap
}

/**
 * 注入层：快照 → system 前部上下文块。
 * 纯函数（快照进、字符串出），单测钉格式；空黑板返回 null（调用方免拼空块）。
 */
export function buildBlackboardContext(
  snap: BlackboardSnapshot,
  cap: number = BOARD_CONTEXT_CAP(),
): string | null {
  if (!snap.exists) return null
  const parts: string[] = []
  if (snap.boardMd && snap.boardMd.trim().length > 0) {
    const board =
      snap.boardMd.length <= cap
        ? snap.boardMd
        : snap.boardMd.slice(0, Math.floor(cap * 0.85)) +
          `\n[任务板截断：原文 ${snap.boardMd.length} 字符，上限 ${cap}]`
    parts.push(`## 任务板（BOARD.md）\n${board}`)
  }
  if (snap.knowledge.length > 0) {
    parts.push(
      `## 共享知识（knowledge/）\n${snap.knowledge
        .map((e) => `- ${e.relPath}${e.mtime ? `（更新于 ${e.mtime.slice(0, 16).replace('T', ' ')}）` : ''}`)
        .join('\n')}`,
    )
  }
  if (snap.handoff.length > 0) {
    parts.push(
      `## 本轮交接（handoff/）\n${snap.handoff
        .map((e) => `- ${e.relPath}`)
        .join('\n')}\n并行分支的产出与结论在上述交接文件里，需要时先读它们再动手。`,
    )
  }
  if (parts.length === 0) return null
  return `[项目黑板 · .agents/ —— 团队共享知识，读写它就是与队友协作]\n${parts.join('\n\n')}`
}
