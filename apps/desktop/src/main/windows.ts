import { join } from 'node:path'
import { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

// 单窗口两阶段（docs/desktop-architecture.md §3.1）：
//   阶段 A 本地启动态页（M1 即此）→ 阶段 B 双健康后 win.loadURL(consoleUrl)（M3 接线）。
// console 意外不可用时（did-fail-load / 健康轮询失败）回退阶段 A 显示恢复过程（M3）。
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'dagents',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  mainWindow = win
  return win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function focusMainWindow(): void {
  const win = mainWindow
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}
