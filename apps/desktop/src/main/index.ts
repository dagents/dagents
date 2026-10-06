import { app } from 'electron'
import { buildAppMenu } from './menu'
import { createMainWindow, focusMainWindow, getMainWindow } from './windows'

// M1 空壳入口：单窗口加载本地启动态占位页。
// M2 起接入编排器（src/main/orchestrator/，纯逻辑禁 import electron），
// M3 双健康后 loadURL(consoleUrl) 接管 —— 进程模型见 docs/desktop-architecture.md §3.1。

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => focusMainWindow())

  void app.whenReady().then(() => {
    buildAppMenu()
    createMainWindow()

    // mac dock 点击：窗口已全关时重建
    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })
  })

  // 关窗即退出（outOfScope：不做托盘常驻）——这是「无孤儿进程」语义的最简实现；
  // M2 起退出前先触发全量进程树终止（docs/desktop-architecture.md §3.4）。
  app.on('window-all-closed', () => {
    app.quit()
  })
}
