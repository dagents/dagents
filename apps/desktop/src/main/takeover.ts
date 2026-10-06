import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { DesktopSnapshot } from './orchestrator/types'

// 就绪接管控制器（docs §3.1 单窗口两阶段 + §12.2 内容意愿态，M7）：
//   阶段 A 本地启动态/错误态页（窗口初始内容）
//   阶段 B snapshot.phase === 'console'（双健康，computePhase 判定）→ loadURL(consoleUrl)
//   console 意外不可用（phase 跌回 boot / did-fail-load）→ 回退阶段 A 显示恢复过程
// 「内容意愿」三态（contentIntent，根治启动态页死路 docs §12.1）：
//   auto    = 现自动行为（双健康接管、跌落回 boot）
//   boot    = 钉住启动态页（原 pinnedBoot 语义；phase 跌落仍自动回 auto——回退不回归）
//   console = 用户意愿进工作台：立即尝试接管；不健康时意愿保留、双健康一恢复即接管
// 不变式（docs §12.2-5 验收口径）：任何时刻可达工作台满足其一——自动接管 / 启动态页
// 按钮（boot 态+双健康）/ 菜单「进入工作台」（永远可点，不健康时给反馈不静默）。
//
// 纯跟随逻辑集中在 onSnapshot（可在无窗口语义下推理）；Electron API 只有
// loadFile/loadURL/isDestroyed——按测试策略属薄壳，不单测（computePhase 已钉表）。

export const BOOT_PAGE_PATH = '../renderer/index.html'

export type WindowContent = 'boot' | 'console' | 'loading'

export type ContentIntent = 'auto' | 'boot' | 'console'

export interface TakeoverDeps {
  win: BrowserWindow
  consoleUrl: string
  log: (line: string) => void
}

export interface TakeoverController {
  onSnapshot(snapshot: DesktopSnapshot): void
  /** 菜单/IPC「服务状态页」：钉住启动态页（服务降级/重启时自动解除）。 */
  showStartupPage(): void
  /** 菜单/IPC/启动态页按钮「进入工作台」：意愿态转 console 并立即尝试接管。 */
  enterWorkbench(): void
  /** 当前内容意愿（渲染层「已钉住」徽标 / 诚实文案的数据源）。 */
  contentIntent(): ContentIntent
  /** 当前窗口内容（诊断/日志用）。 */
  content(): WindowContent
}

export function createTakeoverController(deps: TakeoverDeps): TakeoverController {
  const { win, consoleUrl, log } = deps
  let content: WindowContent = 'boot'
  let intent: ContentIntent = 'auto'
  let lastPhase: DesktopSnapshot['phase'] = 'boot'

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
      lastPhase = snapshot.phase
      if (snapshot.phase !== 'console') {
        // 服务离开健康态：钉住自动解除（boot→auto，恢复自动接管——docs §12.2-1 回退不回归）；
        // console 意愿（用户点了「进入工作台」但服务尚不健康）保留，恢复即接管
        if (intent === 'boot') intent = 'auto'
        if (content !== 'boot') loadBoot(`${snapshot.services.console.state === 'running' ? 'gateway' : 'console'} 不再健康`)
        return
      }
      // 双健康：
      if (intent === 'boot') {
        if (content !== 'boot') loadBoot('启动态页被钉住（菜单「服务状态页」）')
        return
      }
      if (content === 'boot') loadConsole('gateway+console 双健康')
    },
    showStartupPage() {
      intent = 'boot'
      if (win.isDestroyed()) return
      if (content !== 'boot') loadBoot('手动打开启动态页')
    },
    enterWorkbench() {
      intent = 'console'
      if (win.isDestroyed()) return
      // 双健康 → 立即接管；不健康 → 意愿已记录（onSnapshot 下一拍恢复即接管），不硬
      // loadURL（服务没起来时硬加载只会 did-fail-load 来回弹，反而误导）
      if (lastPhase === 'console' && content === 'boot') {
        loadConsole('用户意愿「进入工作台」')
      } else if (lastPhase !== 'console') {
        log('「进入工作台」意愿已记录——服务恢复健康后自动接管')
      }
    },
    contentIntent() {
      return intent
    },
    content() {
      return content
    },
  }
}
