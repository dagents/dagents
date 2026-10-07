#!/usr/bin/env node
/**
 * smoke.mjs —— 本机（win32）真启动冒烟（SMOKE.txt 存在时由里程碑门禁调用）。
 *
 * 链路：定位 dist:win 产出的 release/win-unpacked/dagents.exe → 启动 →
 * 轮询 tasklist 确认 Electron 多进程形态（main/gpu/renderer/utility）→
 * taskkill /PID <pid> /T /F 树终止 → 轮询进程归零。全程干净退出码 0。
 * 与架构文档 §2.3 #9/#10 探针验证的是同一链路，此处为正式接线的可重复脚本。
 * 仅 win32：mac/linux 打包归 CI（约束「本机可验证性」）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const exeName = 'dagents.exe'

/**
 * 定位 dist:win 产出的解包 exe：优先规范位 release/win-unpacked；其次 package-win.mjs
 * 因旧输出目录被外部句柄锁死而换道的 release-stale-<n>（取编号最大＝最近一轮）。
 */
function findUnpackedExe() {
  const canonical = join(pkgRoot, 'release', 'win-unpacked', exeName)
  if (existsSync(canonical)) return canonical
  const stale = readdirSync(pkgRoot)
    .filter((n) => /^release-stale-\d+$/.test(n))
    .sort((a, b) => Number(b.match(/\d+$/)[0]) - Number(a.match(/\d+$/)[0]))
    .map((n) => join(pkgRoot, n, 'win-unpacked', exeName))
    .find(existsSync)
  return stale ?? canonical
}

const exePath = findUnpackedExe()

function countProcesses(name) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV'], {
    encoding: 'utf-8',
  })
  if (r.status !== 0) return 0
  return (r.stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().startsWith(`"${name.toLowerCase()}`)).length
}

async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error(`[smoke] 超时（${label}，${timeoutMs}ms）`)
  return false
}

if (process.platform !== 'win32') {
  console.error('[smoke] 仅支持 win32（mac/linux 打包归 CI，docs/desktop-architecture.md §4.2）')
  process.exit(1)
}
if (!existsSync(exePath)) {
  console.error(`[smoke] 缺少 ${exePath} —— 先跑 pnpm --filter @dagents/desktop run dist:win`)
  process.exit(1)
}

console.log(`[smoke] 启动 ${exePath}`)
const child = spawn(exePath, [], { stdio: 'ignore' })
child.unref()

const up = await poll(
  () => Promise.resolve(countProcesses(exeName) >= 2),
  30_000,
  '等待 Electron 多进程形态出现'
)
if (!up) process.exit(1)
const n = countProcesses(exeName)
console.log(`[smoke] Electron 已启动（tasklist 见 ${n} 个 ${exeName} 进程）`)

console.log(`[smoke] taskkill /PID ${child.pid} /T /F 终止进程树`)
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit' })

const gone = await poll(
  () => Promise.resolve(countProcesses(exeName) === 0),
  20_000,
  '等待进程树完全退出'
)
if (!gone) process.exit(1)

console.log('[smoke] ✅ 启动 + 树终止全程干净，冒烟通过')
process.exit(0)
