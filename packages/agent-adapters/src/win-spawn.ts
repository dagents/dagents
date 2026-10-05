import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * win32 spawn 兼容层（2026-10-05 真机 Windows 全链路验证）。
 *
 * 问题：`spawn('claude', …)`（无 shell）在 Windows 上只能启动 PE 可执行文件
 * （.exe/.bat 直启被 Node CVE-2024-27980 修复后的 EINVAL 拦下）。而 npm 全局
 * 装的 CLI（`npm i -g @anthropic-ai/claude-code` 等）在 Windows 上是
 * `claude.cmd` / `claude.ps1` shim —— spawn('claude') 直接 ENOENT。原生安装
 * （claude.exe / codex.exe）则没有这层问题。
 *
 * 策略（按优先级）：
 *   1. 名称里已带扩展名 / 含路径分隔符 → 原样返回（调用方明确知道自己在干嘛）
 *   2. win32：在 PATH（含 PATHEXT 顺序 .com/.exe/.bat/.cmd）上探测
 *      `<name>.exe`（原生二进制，优先 —— 无 shim 层、无转义面），
 *      命中即返回绝对路径；否则退回 `<name>.cmd`（npm shim，调用方须以
 *      shell 方式 spawn）。
 *   3. POSIX：返回原名（Node spawn 自带 PATH 查找 + shebang 解释）。
 *
 * 纯函数、无副作用：非 win32 恒等返回；win32 探测失败也返回原名（让 spawn
 * 报出与此前一致的 ENOENT 错误，错误语义不因这层包装漂移）。
 */

const WIN_PATHEXT_EXE_FIRST = ['.com', '.exe', '.bat', '.cmd']

/** PATH 目录展开（去空白项；保留原顺序 = PATH 优先级）。 */
function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
}

export interface ResolvedCli {
  /** spawn 第一参数用的路径（win32 命中时是绝对路径）。 */
  path: string
  /**
   * true = `.cmd`/`.bat` shim，spawn 必须带 `shell: true`
   * （Node 对 cmd/bat 直启强制 EINVAL）；false = 直启。
   */
  viaShell: boolean
}

/**
 * 解析 CLI 可执行名的实际 spawn 目标（三平台单源）。
 * 调用方约定：`spawn(resolved.path, args, { shell: resolved.viaShell })`。
 */
export function resolveCliExecutable(name: string): ResolvedCli {
  if (process.platform !== 'win32') {
    return { path: name, viaShell: false }
  }
  // 显式扩展名或带路径：调用方已经写全了 —— 原样透传（存在性由 spawn 报错）。
  if (/\.(com|exe|bat|cmd|ps1)$/i.test(name) || /[\\/]/.test(name)) {
    const viaShell = /\.(cmd|bat)$/i.test(name)
    return { path: name, viaShell }
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
        // unreadable dir entry — keep scanning
      }
    }
    // 无扩展名的裸文件（罕见，但 git-bash 场景存在）也认
    const bare = join(dir, name)
    if (isAbsolute(bare)) {
      try {
        if (existsSync(bare) && statSync(bare).isFile()) {
          return { path: bare, viaShell: false }
        }
      } catch {
        // keep scanning
      }
    }
  }
  // PATH 上没找到：返回原名 —— spawn 的 ENOENT 是既有的诚实失败语义。
  return { path: name, viaShell: false }
}



/**
 * 进程树终止（win32 专用）：`spawn` 走 shell（.cmd shim）时，kill 只送进
 * cmd.exe 外壳 —— 真正的 CLI 孙进程被孤儿化，还握着 stdout 不放（父进程的
 * readline 永远等不到 EOF，run 卡死）。win32 上等价语义是
 * `taskkill /PID <pid> /T /F`（/T = 整棵树，/F = 强制，等价 SIGKILL；
 * TerminateProcess 本就不可被捕获，不存在「SIGTERM 让 CLI 优雅 flush」的
 * POSIX 语义可守）。POSIX 保持 proc.kill 两段式不变。
 */
export function treeKill(pid: number): void {
  if (process.platform !== 'win32') return
  try {
    // fire-and-forget：taskkill 失败（进程已死）是正常竞态，静默即可。
    // 两个关键实现细节（真机验证踩出来的）：
    //   1. spawn 而非 execFile —— execFile 版本在 vitest worker 里静默失败；
    //   2. 同步 require 而非动态 import —— kill 要立即发出，import 的微任务
    //      延迟在 .cmd shim 场景（kill 窗口以毫秒计）是真实的挂死风险。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn: sp } = require('node:child_process') as typeof import('node:child_process')
    const tk = sp('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    tk.on('error', () => {})
    tk.on('exit', () => {})
  } catch {
    // never throw from a kill path
  }
}
