import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import {
  DEFAULT_ZOOM,
  parseWindowState,
  restoreWindowPlacement,
  MIN_HEIGHT,
  MIN_WIDTH,
  type WindowState,
} from './window-state'

// 单窗口两阶段（docs/desktop-architecture.md §3.1）：
//   阶段 A 本地启动态页（M1 即此）→ 阶段 B 双健康后 win.loadURL(consoleUrl)（M3 接线）。
//   console 意外不可用时（did-fail-load / 健康轮询失败）回退阶段 A 显示恢复过程（M3）。
// 窗口状态记忆（体验规格 C8/C9，U1）：位置/尺寸/最大化/缩放持久化到
//   userData/window-state.json，重启恢复；恢复落位（显示器交集/居中回退）纯逻辑
//   在 window-state.ts，本文件只做 Electron 薄壳（fs + screen + 事件接线）。

let mainWindow: BrowserWindow | null = null

const STATE_FILE = 'window-state.json'
/** 拖动/缩放过程中的落盘防抖（resize/move 高频事件不打爆磁盘）。 */
const SAVE_DEBOUNCE_MS = 800

function stateFilePath(): string {
  return join(app.getPath('userData'), STATE_FILE)
}

function loadWindowState(): WindowState | null {
  try {
    return parseWindowState(readFileSync(stateFilePath(), 'utf-8'))
  } catch {
    return null // 首启无文件 / 读失败 → 全新默认窗口
  }
}

function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const state: WindowState = {
      // getNormalBounds：最大化时也记还原尺寸（不把整屏尺寸当正常态存下）
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      zoomFactor: win.webContents.getZoomFactor() || DEFAULT_ZOOM,
    }
    writeFileSync(stateFilePath(), JSON.stringify(state))
  } catch {
    // 落盘失败不阻塞窗口生命周期（下次再试）
  }
}

export function createMainWindow(): BrowserWindow {
  const saved = loadWindowState()
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const primary = screen.getPrimaryDisplay().workArea
  const placement = restoreWindowPlacement(saved, displays, primary)

  const win = new BrowserWindow({
    ...placement.bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Dagents',
    show: false, // 记忆尺寸先就位再显示，避免默认尺寸闪一下（FOUC of geometry）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      zoomFactor: saved?.zoomFactor ?? DEFAULT_ZOOM,
    },
  })
  if (placement.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  void win.loadFile(join(__dirname, '../renderer/index.html'))

  // 状态记忆：几何变化防抖落盘；close 时立即补一次最终态
  let saveTimer: NodeJS.Timeout | null = null
  const scheduleSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistWindowState(win)
    }, SAVE_DEBOUNCE_MS)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  win.on('close', () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persistWindowState(win)
  })

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
