import { join } from 'node:path'
import { app, shell } from 'electron'
import { loadConfig } from './orchestrator/config'
import { Orchestrator } from './orchestrator/supervisor'
import { registerDesktopIpc } from './ipc'
import { buildAppMenu } from './menu'
import { createRuntimeDeps } from './spawn-runtime'
import { createTakeoverController, type TakeoverController } from './takeover'
import { createMainWindow, focusMainWindow, getMainWindow } from './windows'

// 主入口（docs §3.1 进程模型）：
//   app ready → 加载配置 → 建编排器 → 窗口（阶段 A 启动态页）
//   → IPC 桥 + 菜单 + 接管控制器 → 编排启动
//   双健康（computePhase）→ 窗口 loadURL(consoleUrl) 进入阶段 B；
//   console 崩溃/健康跌落 → 回退阶段 A 显示有界重启与引导。
// 退出：window-all-closed → app.quit() → will-quit 先全量树终止再退（无孤儿语义）。

let orchestrator: Orchestrator | null = null
let takeover: TakeoverController | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => focusMainWindow())

  void app.whenReady().then(() => {
    const userData = app.getPath('userData')
    const { config, warnings } = loadConfig({
      userDataDir: userData,
      // dev 模式 = apps/desktop（electron .）→ 向上发现 pnpm-workspace.yaml 即仓库根
      startDir: app.getAppPath(),
    })
    for (const w of warnings) console.warn(`[desktop-config] ${w}`)

    orchestrator = new Orchestrator(
      config,
      createRuntimeDeps(config, { logDir: join(userData, 'logs') })
    )

    const win = createMainWindow()
    takeover = createTakeoverController({
      win,
      consoleUrl: config.consoleUrl,
      log: (line) => console.log(`[takeover] ${line}`),
    })
    registerDesktopIpc(win, orchestrator)
    buildAppMenu({
      onRestartServices: () => void orchestrator?.restartAll(),
      onStopServices: () => void orchestrator?.stopAll(),
      onShowStartupPage: () => takeover?.showStartupPage(),
      onOpenConsoleInBrowser: () => void shell.openExternal(config.consoleUrl),
    })

    // mac dock 点击：窗口已全关时重建
    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })

    orchestrator.onChange(() => {
      const orch = orchestrator
      if (orch) takeover?.onSnapshot(orch.snapshot())
    })
    takeover.onSnapshot(orchestrator.snapshot())
    orchestrator.start()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 关窗即退出的收尾：先全量树终止（端口释放校验在 stopAll 内），再真正退出。
  // 6s 兜底防止 taskkill 卡死拖住退出（正常 <1s）。
  app.on('will-quit', (event) => {
    if (orchestrator === null) return
    const orch = orchestrator
    event.preventDefault()
    void Promise.race([orch.stopAll(), new Promise((r) => setTimeout(r, 6_000))]).then(() => {
      app.exit(0)
    })
  })
}
