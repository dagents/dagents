#!/usr/bin/env node
/**
 * ensure-electron.mjs —— 显式按需下载 Electron 二进制（docs/desktop-architecture.md §2.4）。
 *
 * 供应链背景（全部本机实测，见架构文档 §2.3 证据表）：
 *   - electron@44.5.1 的 npm 包**没有 install script**（registry 元数据 scripts:null），
 *     仓库 .npmrc ignore-scripts=true 之下 pnpm install 期间零下载、零脚本执行——
 *     白名单机制根本不介入，pnpm-workspace.yaml 无需新增条目。
 *   - 二进制只在本脚本被**显式**调用时下载（dev / dist:win / CI 打包 job）；
 *     纯检查场景（vitest/tsc/eslint）不触碰二进制。
 *   - 44.5.1 的 install.js 不存在 ELECTRON_SKIP_BINARY_DOWNLOAD 开关（tarball grep
 *     零命中）——skip 语义由本脚本自己的 DAGENTS_DESKTOP_SKIP_ELECTRON=1 短路实现。
 *
 * 镜像：ELECTRON_MIRROR 默认 npmmirror（本机网络实测可达），环境变量可覆盖。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.DAGENTS_DESKTOP_SKIP_ELECTRON === '1') {
  console.log('[ensure-electron] DAGENTS_DESKTOP_SKIP_ELECTRON=1，跳过二进制检查')
  process.exit(0)
}

const require = createRequire(import.meta.url)
let electronDir
try {
  electronDir = dirname(require.resolve('electron'))
} catch {
  console.error('[ensure-electron] 解析 electron 包失败——先在仓库根跑 pnpm install')
  process.exit(1)
}

// electron 包约定：install 完成后写 path.txt（内容为平台二进制文件名），
// index.js 依据它拼 dist/<binary> 的路径——存在与否即「二进制是否就位」。
function binaryPath() {
  const pathTxt = join(electronDir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  return join(electronDir, 'dist', readFileSync(pathTxt, 'utf-8').trim())
}

const existing = binaryPath()
if (existing && existsSync(existing)) {
  console.log(`[ensure-electron] 二进制已就位：${existing}`)
  process.exit(0)
}

const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
console.log(`[ensure-electron] 二进制缺失，经 install.js 按需下载（ELECTRON_MIRROR=${mirror}）`)
const res = spawnSync(process.execPath, ['install.js'], {
  cwd: electronDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: mirror },
})

if (res.status !== 0) {
  console.error(`[ensure-electron] install.js 退出码 ${res.status}`)
  process.exit(1)
}

const after = binaryPath()
if (!after || !existsSync(after)) {
  console.error('[ensure-electron] install.js 跑完但二进制仍未就位（检查上方输出/镜像可达性）')
  process.exit(1)
}
console.log(`[ensure-electron] ✅ 二进制就位：${after}`)
