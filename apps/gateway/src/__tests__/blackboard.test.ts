import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLACKBOARD_DIR,
  readBlackboardSnapshot,
  buildBlackboardContext,
  BOARD_CONTEXT_CAP,
} from '../lib/blackboard.js'

/**
 * 文件黑板单测（注入块格式 + 快照容错）—— 纯文件系统，无 DB。
 * 快照缓存按 projectRoot 键控：每个用例独立临时目录互不污染。
 */

function makeProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dagents-bb-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, BLACKBOARD_DIR, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('readBlackboardSnapshot', () => {
  let roots: string[] = []
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    roots = []
  })

  it('无黑板目录 → exists=false 空快照（引导态不是错误）', () => {
    const root = mkdtempSync(join(tmpdir(), 'dagents-bb-'))
    roots.push(root)
    const snap = readBlackboardSnapshot(root)
    expect(snap.exists).toBe(false)
    expect(snap.boardMd).toBeNull()
    expect(snap.knowledge).toEqual([])
  })

  it('读出 BOARD.md + knowledge/handoff 清单，mtime 降序', () => {
    const root = makeProject({
      'BOARD.md': '# 任务板\n- [ ] 做事',
      'knowledge/a.md': 'A',
      'knowledge/b.md': 'B',
      'handoff/h1.md': '交接',
    })
    roots.push(root)
    const snap = readBlackboardSnapshot(root)
    expect(snap.exists).toBe(true)
    expect(snap.boardMd).toContain('任务板')
    expect(snap.knowledge).toHaveLength(2)
    expect(snap.handoff[0]?.relPath).toBe('handoff/h1.md')
    // 同批写入的文件 mtime 可能同毫秒 —— 只断言集合，不断言次序细节
    const names = snap.knowledge.map((e) => e.name).sort()
    expect(names).toEqual(['a.md', 'b.md'])
  })
})

describe('buildBlackboardContext', () => {
  it('空黑板 → null（调用方免拼空块）', () => {
    const snap = readBlackboardSnapshot(makeProject({}))
    expect(buildBlackboardContext(snap)).toBeNull()
  })

  it('三块齐全 → 注入块带分段标题与交接指引', () => {
    const snap = readBlackboardSnapshot(
      makeProject({
        'BOARD.md': '# 任务板',
        'knowledge/k.md': '结论',
        'handoff/x.md': '产出',
      }),
    )
    const block = buildBlackboardContext(snap)
    expect(block).toContain('[项目黑板')
    expect(block).toContain('## 任务板')
    expect(block).toContain('## 共享知识')
    expect(block).toContain('## 本轮交接')
    expect(block).toContain('先读它们再动手')
  })

  it('BOARD.md 超预算截断并诚实标注', () => {
    const cap = 100
    const snap = readBlackboardSnapshot(
      makeProject({ 'BOARD.md': 'x'.repeat(cap * 2) }),
    )
    const block = buildBlackboardContext(snap, cap)
    expect(block).toContain('[任务板截断')
    expect(block!.length).toBeLessThan(cap * 2)
  })

  it('BOARD_CONTEXT_CAP 默认 4096，env 可覆盖', () => {
    const orig = process.env.DAGENTS_BOARD_CONTEXT_CAP
    try {
      expect(BOARD_CONTEXT_CAP()).toBe(4096)
      process.env.DAGENTS_BOARD_CONTEXT_CAP = '2048'
      expect(BOARD_CONTEXT_CAP()).toBe(2048)
    } finally {
      if (orig === undefined) delete process.env.DAGENTS_BOARD_CONTEXT_CAP
      else process.env.DAGENTS_BOARD_CONTEXT_CAP = orig
    }
  })
})
