import { spawn, spawnSync } from 'node:child_process'

// 进程树终止。蓝本：packages/agent-adapters/src/win-spawn.ts:98-114（commit
// 038e12f win32 真机验证），两个关键坑照抄：
//   1. spawn 而非 execFile——execFile 版本在 vitest worker 里静默失败；
//   2. 顶层同步 import 而非动态 import——kill 要立即发出，动态 import 的微任务
//      延迟在 .cmd shim 场景（kill 窗口以毫秒计）是真实挂死风险。
//
// 与蓝本的差异：这里需要「终止完成」的回执（停止验收以端口释放为准），
// 所以异步版等待 taskkill 退出；另有同步版供 Electron will-quit 阻塞路径用。

/** win32：taskkill /PID <pid> /T /F（/T 整棵树 /F 强制，TerminateProcess 不可捕获）。 */
export function treeKillWinSync(pid: number): void {
  if (process.platform !== 'win32') return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    })
  } catch {
    // never throw from a kill path（进程已死是正常竞态）
  }
}

/** 异步版：等待终止完成（resolve = 树已灭或本就没人）。 */
function treeKillWin(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      tk.on('error', () => resolve())
      tk.on('exit', () => resolve())
      // 兜底：taskkill 卡死不让停机流程挂死
      const guard = setTimeout(() => resolve(), 15_000)
      guard.unref?.()
    } catch {
      resolve()
    }
  })
}

/** POSIX：SIGTERM → graceMs 宽限 → SIGKILL（gateway 有优雅停机链，先礼后兵）。 */
async function treeKillPosix(pid: number, graceMs: number): Promise<void> {
  const tryKill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig) // 负号 = 进程组（spawn detached:true 建立）
    } catch {
      try {
        process.kill(pid, sig) // 组不存在（未 detached）则直接杀主进程
      } catch {
        // 已死是正常竞态
      }
    }
  }
  tryKill('SIGTERM')
  await new Promise((r) => setTimeout(r, graceMs))
  tryKill('SIGKILL')
}

/** 跨平台树终止（等待完成）。graceMs 仅 POSIX 生效。 */
export async function treeKill(pid: number, graceMs = 2_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') return treeKillWin(pid)
  return treeKillPosix(pid, graceMs)
}
