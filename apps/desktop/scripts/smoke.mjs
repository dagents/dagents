#!/usr/bin/env node
/**
 * smoke.mjs —— 本机（win32）真启动冒烟（SMOKE.txt 存在时由里程碑门禁调用）。
 *
 * 默认模式链路：定位 dist:win 产出的 release/win-unpacked/dagents.exe → 启动 →
 * 轮询 tasklist 确认 Electron 多进程形态（main/gpu/renderer/utility）→
 * taskkill /PID <pid> /T /F 树终止 → 轮询进程归零。全程干净退出码 0。
 * 与架构文档 §2.3 #9/#10 探针验证的是同一链路，此处为正式接线的可重复脚本。
 *
 * 冲突模式（`node scripts/smoke.mjs conflict`，M9 docs §18.8）：哑 listener 占住
 * 三默认端口（8080/3000/55432，陌生监听者形态）→ 启动 exe → 断言三服务让位到
 * 8081/3001/55433 监听（netstat）且哑 listener 存活（不误杀）→ 树终止 → 断言
 * 让位端口释放、进程归零。前置：三默认端口空闲（无真 dagents 实例——那会走附加
 * 而非让位）且无其他 dagents 桌面实例在跑（单实例锁）。
 * 仅 win32：mac/linux 打包归 CI（约束「本机可验证性」）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
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

/** netstat 断言：端口处于 LISTENING（`:port` 精确匹配，排除 :80800 之类前缀误报）。 */
function portListening(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf-8' })
  if (r.status !== 0) return false
  return (r.stdout || '')
    .split(/\r?\n/)
    .some((l) => new RegExp(`:${port}\\s+.*LISTENING`, 'i').test(l))
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

/** 陌生 HTTP 监听者（gateway/console 端口形态）：应答非 dagents 的 JSON/HTML。 */
function dummyStranger(port) {
  return new Promise((resolve) => {
    const srv = createHttpServer((rq, rs) => {
      if (rq.url === '/health') {
        rs.writeHead(200, { 'content-type': 'application/json' })
        rs.end('{"ok":true}')
      } else {
        rs.writeHead(200, { 'content-type': 'text/html' })
        rs.end('<!doctype html><title>SomeOtherApp</title>')
      }
    })
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

/** 哑 TCP 监听者（pg 端口形态——pg 无身份判别，任何占用者都触发让位）。 */
function dummyTcp(port) {
  const srv = createTcpServer()
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)))
}

function closeServer(srv) {
  return new Promise((resolve) => srv.close(() => resolve()))
}

if (process.platform !== 'win32') {
  console.error('[smoke] 仅支持 win32（mac/linux 打包归 CI，docs/desktop-architecture.md §4.2）')
  process.exit(1)
}
if (!existsSync(exePath)) {
  console.error(`[smoke] 缺少 ${exePath} —— 先跑 pnpm --filter @dagents/desktop run dist:win`)
  process.exit(1)
}

const conflictMode = process.argv[2] === 'conflict'
const DEFAULTS = [8080, 3000, 55432]
const YIELDED = [8081, 3001, 55433]

let dummies = []
if (conflictMode) {
  for (const port of DEFAULTS) {
    if (portListening(port)) {
      console.error(`[smoke] 前置不满足：端口 ${port} 已被占用（需空闲后由哑 listener 占位）`)
      process.exit(1)
    }
  }
  dummies = [await dummyStranger(8080), await dummyStranger(3000), await dummyTcp(55432)]
  console.log('[smoke] 冲突模式：哑 listener 已占 8080/3000/55432（陌生监听者形态）')
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

let ok = true
if (conflictMode) {
  // 三服务让位断言：实际端口监听在 +1 段（pg initdb/迁移在首启要几秒，给足预算）
  const yielded = await poll(
    () => Promise.resolve(YIELDED.every((p) => portListening(p))),
    120_000,
    '等待让位端口 8081/3001/55433 监听'
  )
  if (!yielded) {
    process.exit(1)
  }
  console.log('[smoke] 让位端口 8081/3001/55433 全部 LISTENING（netstat 断言通过）')
  // 默认端口仍被哑 listener 持有——本 app 未抢占未误杀
  if (!DEFAULTS.every((p) => portListening(p))) {
    console.error('[smoke] ✗ 哑 listener 端口丢失（8080/3000/55432 应仍被本脚本持有）')
    ok = false
  } else {
    console.log('[smoke] 哑 listener 全部存活（未抢占未误杀）')
  }
}

console.log(`[smoke] taskkill /PID ${child.pid} /T /F 终止进程树`)
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit' })

const gone = await poll(
  () => Promise.resolve(countProcesses(exeName) === 0),
  20_000,
  '等待进程树完全退出'
)
if (!gone) process.exit(1)

if (conflictMode && ok) {
  const released = await poll(
    () => Promise.resolve(!YIELDED.some((p) => portListening(p))),
    15_000,
    '等待让位端口释放'
  )
  if (!released) process.exit(1)
  console.log('[smoke] 让位端口全部释放（树终止停净）')
  for (const d of dummies) await closeServer(d)
  console.log('[smoke] ✅ 冲突模式通过：让位 + 不误杀 + 停净')
  process.exit(ok ? 0 : 1)
}
if (!ok) process.exit(1)

console.log('[smoke] ✅ 启动 + 树终止全程干净，冒烟通过')
process.exit(0)
