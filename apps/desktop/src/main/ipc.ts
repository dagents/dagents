import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { Orchestrator } from './orchestrator/supervisor'

// IPC 桥（docs §3.4）：preload 窄暴露面在主进程侧的落点。
//   getState   —— invoke 同步快照
//   onState    —— 主进程推送，250ms 合并节流（轮询/日志行高频变化不打爆渲染层）
//   restart/stop —— 编排控制
//   openExternal —— 仅 http(s)，引导文案里的外链出口
export function registerDesktopIpc(win: BrowserWindow, orch: Orchestrator): void {
  ipcMain.handle('desktop:getState', () => orch.snapshot())
  ipcMain.handle('desktop:restart', async () => {
    await orch.restartAll()
  })
  ipcMain.handle('desktop:stop', async () => {
    await orch.stopAll()
  })
  ipcMain.handle('desktop:openExternal', (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  let lastSentAt = 0
  let scheduled: NodeJS.Timeout | null = null
  const push = () => {
    scheduled = null
    lastSentAt = Date.now()
    if (!win.isDestroyed()) win.webContents.send('desktop:state', orch.snapshot())
  }
  orch.onChange(() => {
    if (scheduled !== null) return
    const elapsed = Date.now() - lastSentAt
    scheduled = setTimeout(push, Math.max(0, 250 - elapsed))
  })

  // 窗口销毁时取消挂起的推送
  win.on('closed', () => {
    if (scheduled !== null) {
      clearTimeout(scheduled)
      scheduled = null
    }
  })
}
