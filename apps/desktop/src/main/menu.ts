import { Menu, type MenuItemConstructorOptions } from 'electron'

// 全 role 化基础菜单（mac 没有基础菜单连复制粘贴都没有）+ 自定义「服务」菜单
// （docs §3.4）。M3 起四动作全接：重启/停止（编排器）、打开启动态页（takeover
// pin）、在浏览器打开 console（shell.openExternal）。
export interface MenuHandlers {
  onRestartServices?: () => void
  onStopServices?: () => void
  onShowStartupPage?: () => void
  onOpenConsoleInBrowser?: () => void
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
        {
          label: '打开启动态页（服务编排状态与日志）',
          enabled: handlers.onShowStartupPage !== undefined,
          click: () => handlers.onShowStartupPage?.(),
        },
        {
          label: '在浏览器打开 console',
          enabled: handlers.onOpenConsoleInBrowser !== undefined,
          click: () => handlers.onOpenConsoleInBrowser?.(),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
