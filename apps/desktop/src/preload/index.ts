import { contextBridge } from 'electron'

// M1 暴露面占位：只证明 contextIsolation + preload 管线接通。
// M2 起按 docs/desktop-architecture.md §3.4 扩为
// getState / onState(250ms 节流) / restart / stop / openExternal。
// 边界（R8）：preload 对窗口内所有页面注入（含 console 远程页）——本机第一方
// 内容可接受；未来支持远程 gateway 前必须撤远程页注入。
contextBridge.exposeInMainWorld('dagentsDesktop', {
  bridge: 'stub' as const,
})
