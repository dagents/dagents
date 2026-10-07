import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

// win32 spawn 解析（最小内聚副本）。
// 蓝本：packages/agent-adapters/src/win-spawn.ts:50-86（resolveCliExecutable，
// commit 038e12f win32 真机验证）。此处按设计 §3.3 刻意取「最小副本」而非依赖
// @dagents/agent-adapters——那会引入 gateway 的依赖树（含 node-pty 原生模块），
// 违反 desktop 零 workspace 依赖与构建隔离约束。行为契约由同款单测钉住
// （resolve.test.ts，对照 win-spawn.test.ts）。

const WIN_PATHEXT_EXE_FIRST = ['.com', '.exe', '.bat', '.cmd']

function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
}

export interface ResolvedCommand {
  /** spawn 第一参数（win32 命中时为绝对路径）。 */
  path: string
  /** true = .cmd/.bat shim，须 shell:true spawn（Node 对直启强制 EINVAL）。 */
  viaShell: boolean
}

/**
 * 解析命令名的实际 spawn 目标（三平台单源）。
 * 调用方约定：`spawn(resolved.path, args, { shell: resolved.viaShell })`。
 * 未命中 PATH 时返回原名——spawn 的 ENOENT 是既有诚实失败语义（错误不漂移）。
 */
export function resolveCommand(name: string): ResolvedCommand {
  if (process.platform !== 'win32') {
    return { path: name, viaShell: false }
  }
  // 显式扩展名或带路径：调用方已写全——原样透传（存在性由 spawn 报错）。
  if (/\.(com|exe|bat|cmd|ps1)$/i.test(name) || /[\\/]/.test(name)) {
    return { path: name, viaShell: /\.(cmd|bat)$/i.test(name) }
  }
  const exeFirst = process.env.PATHEXT?.split(';').map((e) => e.toLowerCase())
  const exts = exeFirst && exeFirst.length > 0 ? exeFirst : WIN_PATHEXT_EXE_FIRST
  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return { path: candidate, viaShell: ext === '.cmd' || ext === '.bat' }
        }
      } catch {
        // 不可读目录项——继续扫
      }
    }
    const bare = join(dir, name)
    if (isAbsolute(bare)) {
      try {
        if (existsSync(bare) && statSync(bare).isFile()) {
          return { path: bare, viaShell: false }
        }
      } catch {
        // 继续扫
      }
    }
  }
  return { path: name, viaShell: false }
}
