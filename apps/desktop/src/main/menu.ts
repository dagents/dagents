import { Menu, type MenuItemConstructorOptions } from 'electron'

// 全 role 化基础菜单（mac 没有基础菜单连复制粘贴都没有）+ 自定义「服务」菜单
// （docs §3.4）。M2 接入编排器控制（重启/停止）；「打开启动态页 / 在浏览器打开
// console」随 M3 两阶段窗口接线。
export interface MenuHandlers {
  onRestartServices?: () => void
  onStopServices?: () => void
}

export function buildAppMenu(handlers: MenuHandlers = {}): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '服务',
      submenu: [
        {
          label: '重启服务（停止后重新拉起）',
          enabled: handlers.onRestartServices !== undefined,
          click: () => handlers.onRestartServices?.(),
        },
        {
          label: '停止服务（终止全部子进程树）',
          enabled: handlers.onStopServices !== undefined,
          click: () => handlers.onStopServices?.(),
        },
        { type: 'separator' },
        { label: '打开启动态页（M3 两阶段接线）', enabled: false },
        { label: '在浏览器打开 console（M3 接线）', enabled: false },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
