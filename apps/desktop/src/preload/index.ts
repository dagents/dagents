import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopSnapshot } from '../main/orchestrator/types'

// 窄暴露面（docs §3.4）：contextIsolation 之下渲染层唯一能摸到的桥。
// 契约由 tsc typecheck 钉住（DesktopSnapshot 单源：orchestrator/types.ts）。
// 边界（R8）：本 preload 对窗口内所有页面注入——console 为本机第一方内容；
// 未来支持远程 gateway 前必须撤远程页注入。
const api = {
  getState: (): Promise<DesktopSnapshot> => ipcRenderer.invoke('desktop:getState'),
  onState: (cb: (snapshot: DesktopSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snapshot: DesktopSnapshot) => cb(snapshot)
    ipcRenderer.on('desktop:state', listener)
    return () => ipcRenderer.off('desktop:state', listener)
  },
  restart: (): Promise<void> => ipcRenderer.invoke('desktop:restart'),
  stop: (): Promise<void> => ipcRenderer.invoke('desktop:stop'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('desktop:openExternal', url),
}

contextBridge.exposeInMainWorld('dagentsDesktop', api)

export type DesktopApi = typeof api
