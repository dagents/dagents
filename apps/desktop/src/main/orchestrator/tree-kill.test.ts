import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeKill, treeKillWinSync } from './tree-kill'

// 真子进程组树单测（cancellation.test.ts 先例）：用 process.execPath（node.exe）
// 起「父 node → 子 node」两层树，treeKill 后断言 tasklist/kill 查无残留。
// win32 断言用 tasklist（设计 §6：win32 断言 tasklist 查无残留）。

function tasklistCount(name: string): number {
  if (process.platform !== 'win32') return 0
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV'], { encoding: 'utf-8' })
  return (r.stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().startsWith(`"${name.toLowerCase()}`)).length
}

const MARKER = `dagents-desktop-treekill-${Date.now()}`

/** 组树脚本：父进程 spawn 一个睡 60s 的子进程，各自写一行标记文件。 */
const TREE_SCRIPT = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
  stdio: 'ignore',
  windowsHide: true,
})
fs.appendFileSync(process.argv[2], 'parent ' + process.pid + ' child ' + child.pid + '\\n')
setInterval(() => {}, 1000)
`

async function spawnTree(dir: string): Promise<number> {
  const script = join(dir, 'tree.cjs')
  const marker = join(dir, 'marker.txt')
  await writeFile(script, TREE_SCRIPT)
  const proc = spawn(process.execPath, [script, marker], { stdio: 'ignore', windowsHide: true })
  // 等标记文件出现（证明孙进程已 spawn）
  const fs = await import('node:fs')
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (fs.existsSync(marker)) return proc.pid as number
  }
  throw new Error('tree marker never appeared')
}

describe('treeKill（真子进程树）', () => {
  it('终止父+子整棵树，进程无残留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dagents-desktop-tk-'))
    let parentPid = 0
    try {
      parentPid = await spawnTree(dir)
      expect(parentPid).toBeGreaterThan(0)

      await treeKill(parentPid, 500)
      await new Promise((r) => setTimeout(r, 1500))

      // 断言一：父进程已死（node -e 直接探活）
      const alive = spawnSync('node', ['-e', `process.kill(${parentPid}, 0)`], { encoding: 'utf-8' })
      expect(alive.status).not.toBe(0)

      // 断言二（win32）：tasklist 里没有本测试遗留的 node 树（以标记文件里的 pid 为准）
      if (process.platform === 'win32') {
        const fs = await import('node:fs')
        const marker = fs.readFileSync(join(dir, 'marker.txt'), 'utf-8')
        const m = marker.match(/parent (\d+) child (\d+)/)
        expect(m).not.toBeNull()
        const childPid = Number(m?.[2])
        const childAlive = spawnSync('node', ['-e', `process.kill(${childPid}, 0)`], { encoding: 'utf-8' })
        expect(childAlive.status).not.toBe(0) // 孙进程也被 /T 灭掉
        expect(tasklistCount(`${MARKER}.exe`)).toBe(0) // 防御式：绝无同名残留
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('杀不存在的 pid 不抛错（正常竞态）', async () => {
    await expect(treeKill(999_999_999, 10)).resolves.toBeUndefined()
  })

  it.skipIf(process.platform !== 'win32')('treeKillWinSync 同步路径也可用且不抛', () => {
    expect(() => treeKillWinSync(999_999_999)).not.toThrow()
  })
})
