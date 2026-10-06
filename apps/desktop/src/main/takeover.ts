import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { DesktopSnapshot } from './orchestrator/types'

// 就绪接管控制器（docs §3.1 单窗口两阶段）：
//   阶段 A 本地启动态/错误态页（窗口初始内容）
//   阶段 B snapshot.phase === 'console'（双健康，computePhase 判定）→ loadURL(consoleUrl)
//   console 意外不可用（phase 跌回 boot / did-fail-load）→ 回退阶段 A 显示恢复过程
// 「打开启动态页」= pin：把启动态页钉在窗口（服务再健康也不抢）；phase 一旦跌回
// boot（服务重启/降级）自动解除 pin，恢复自动接管。
//
// 纯跟随逻辑集中在 onSnapshot（可在无窗口语义下推理）；Electron API 只有
// loadFile/loadURL/isDestroyed——按测试策略属薄壳，不单测（computePhase 已钉表）。

export const BOOT_PAGE_PATH = '../renderer/index.html'

export type WindowContent = 'boot' | 'console' | 'loading'

export interface TakeoverDeps {
  win: BrowserWindow
  consoleUrl: string
  log: (line: string) => void
}

export interface TakeoverController {
  onSnapshot(snapshot: DesktopSnapshot): void
  /** 菜单「打开启动态页」：钉住启动态页（服务降级/重启时自动解除）。 */
  showStartupPage(): void
  /** 当前窗口内容（诊断/日志用）。 */
  content(): WindowContent
}

export function createTakeoverController(deps: TakeoverDeps): TakeoverController {
  const { win, consoleUrl, log } = deps
  let content: WindowContent = 'boot'
  let pinnedBoot = false

  const loadBoot = (reason: string) => {
    if (win.isDestroyed()) return
    content = 'boot'
    void win.loadFile(join(__dirname, BOOT_PAGE_PATH))
    log(`回退启动态页（${reason}）`)
  }

  const loadConsole = (reason: string) => {
    if (win.isDestroyed()) return
    content = 'loading'
    log(`接管工作台 → ${consoleUrl}（${reason}）`)
    win
      .loadURL(consoleUrl)
      .then(() => {
        content = 'console'
      })
      .catch((err: unknown) => {
        // did-fail-load 也会兜；此处兜 loadURL promise 层的失败（如导航被取消）
        log(`loadURL 失败：${err instanceof Error ? err.message : String(err)}`)
        loadBoot('loadURL 失败')
      })
  }

  // console 页加载失败（服务在导航瞬间死了/代理断了）→ 回退启动态页显示恢复过程
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return
      if (errorCode === -3) return // ERR_ABORTED：多为我方主动切换导航，忽略
      if (content === 'boot') return
      loadBoot(`页面加载失败 ${errorCode} ${errorDescription}`)
    }
  )

  return {
    onSnapshot(snapshot) {
      if (win.isDestroyed()) return
      if (snapshot.phase !== 'console') {
        pinnedBoot = false // 服务离开健康态即解除钉住（重启/降级后恢复自动接管）
        if (content !== 'boot') loadBoot(`${snapshot.services.console.state === 'running' ? 'gateway' : 'console'} 不再健康`)
        return
      }
      // 双健康：
      if (pinnedBoot) {
        if (content !== 'boot') loadBoot('启动态页被钉住（菜单「打开启动态页」）')
        return
      }
      if (content === 'boot') loadConsole('gateway+console 双健康')
    },
    showStartupPage() {
      pinnedBoot = true
      if (win.isDestroyed()) return
      if (content !== 'boot') loadBoot('手动打开启动态页')
    },
    content() {
      return content
    },
  }
}
