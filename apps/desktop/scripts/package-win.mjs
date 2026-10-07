#!/usr/bin/env node
/**
 * package-win.mjs —— dist:win 末步：electron-builder 包装（旧输出目录被外部句柄锁死时换道）。
 *
 * 背景（2026-10-07 本机实测复现）：electron-builder 打包前会清空 appOutDir
 * （release/win-unpacked），对被外部进程占用的文件 unlink 即 EBUSY 且零重试直接
 * 退出 1——上一轮产物只要被谁持有就锁死整条链（本机元凶：编辑器宿主 app-server
 * 对 app.asar 的泄漏句柄；同类：AV/索引器秒级瞬时锁、真机冒烟残留的 dagents.exe）。
 * win 上这类句柄多无 FILE_SHARE_DELETE——文件删不掉也改不了名，目录又被文件监视器
 * 按住连目录改名都失败，「清掉旧目录再原位构建」在被锁时根本走不通。
 * （先例：stage/services 同类锁换名 dist-services 绕道，见 stage-stack.mjs 头注；
 *   .gitignore 的 release 开头通配即为本类替代输出名预留。）
 *
 * 对策两级：
 *   1) 正常路径：有界重试删除 win-unpacked（抗 AV/索引器秒级瞬时锁）→ 原位构建；
 *   2) 锁死路径：换道全新输出目录 release-stale-<n>（新目录无历史句柄，清空无锁可碰），
 *      大声打印产物落点与回位条件；旧 release/ 原地保留，句柄释放后下一轮自动回原位。
 *   CI 不受影响：desktop.yml 直调 electron-builder（fresh checkout 无旧输出），不经过本脚本。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
// 与 electron-builder.yml directories.output 同源（check-builder-config.mjs 断言其值
// 恒为 release，本脚本不改 yml、只在被锁时以 CLI 覆盖），改动需两处同步
const OUTPUT_DIR = 'release'
const STALE_PREFIX = 'release-stale-'

function say(msg) {
  console.log(`[package-win] ${msg}`)
}

/** 有界重试删除 appOutDir（抗 AV/索引器秒级瞬时锁）；返回是否真的删干净。 */
function cleanAppOut() {
  const appOut = join(pkgRoot, OUTPUT_DIR, 'win-unpacked')
  if (!existsSync(appOut)) return true
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(appOut, { recursive: true, force: true })
    } catch {
      // EBUSY/EPERM：进入下一轮重试
    }
    if (!existsSync(appOut)) return true
    // 同步 sleep 2s（零依赖）：阻塞主线程正是此处想要的行为
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  }
  return false
}

/** 历史换道目录尽力清扫（外部句柄已释放的残留）；仍锁死的保留并计数，不阻塞构建。 */
function sweepStaleDirs() {
  let swept = 0
  let stuck = 0
  for (const name of readdirSync(pkgRoot)) {
    if (!name.startsWith(STALE_PREFIX)) continue
    try {
      rmSync(join(pkgRoot, name), { recursive: true, force: true })
      swept++
    } catch {
      stuck++
    }
  }
  if (swept || stuck) {
    say(`历史换道目录清扫：删除 ${swept} 个${stuck ? `，仍被外部句柄锁住保留 ${stuck} 个` : ''}`)
  }
}

function nextStaleDir() {
  for (let n = 1; ; n++) {
    if (!existsSync(join(pkgRoot, `${STALE_PREFIX}${n}`))) return `${STALE_PREFIX}${n}`
  }
}

// ---------------------------------------------------------------------------
// 1. 输出目录就绪：清得动 → 原位构建；清不动（外部句柄锁死）→ 换道全新目录
// ---------------------------------------------------------------------------
sweepStaleDirs()
const args = ['--win', 'nsis', '--publish', 'never']
if (!cleanAppOut()) {
  const alt = nextStaleDir()
  args.push(`--config.directories.output=${alt}`)
  say(
    `⚠ ${OUTPUT_DIR}/win-unpacked 被外部进程锁定删不掉（编辑器/AV 持有句柄）——本轮换道输出目录 ${alt}/` +
      `（安装包与 win-unpacked 均在其中）；锁释放后下一轮构建自动回 ${OUTPUT_DIR}/`
  )
}

// ---------------------------------------------------------------------------
// 2. electron-builder（显式解析本包 .bin shim——脱离 pnpm script 环境直跑也可用；
//    win 下 .cmd shim 须 shell，路径加引号防空格）
// ---------------------------------------------------------------------------
const binBase = join(pkgRoot, 'node_modules', '.bin', 'electron-builder')
const bin = existsSync(binBase + (process.platform === 'win32' ? '.cmd' : ''))
  ? `"${binBase}${process.platform === 'win32' ? '.cmd' : ''}"`
  : 'electron-builder'
const res = spawnSync(bin, args, {
  cwd: pkgRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (res.error) {
  console.error(`[package-win] electron-builder 启动失败：${res.error.message}`)
  process.exit(1)
}
process.exit(res.status ?? 1)
