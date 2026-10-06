import { Menu, type MenuItemConstructorOptions } from 'electron'

// 全 role 化基础菜单（mac 没有基础菜单连复制粘贴都没有）+ 自定义「服务」菜单
// （docs §3.4）。M7 重排（§12.2-4，死路根治）：**进入工作台**置顶（Electron 原生
// 菜单层不受任何 web 页面崩溃影响——故障态兜底第一锚点，永远可点，不健康时由
// takeover 给日志反馈不静默）；「打开启动态页」改名「服务状态页」（语义即钉住）。
export interface MenuHandlers {
  onEnterWorkbench?: () => void
  onShowStartupPage?: () => void
  onRestartServices?: () => void
  onStopServices?: () => void
  onOpenConsoleInBrowser?: () => void
  /** 打开内嵌 PG 数据目录（数据在用户手里——原则 9 的菜单锚点）。 */
  onOpenDataFolder?: () => void
  /** 打开子进程日志目录（D7）。 */
  onOpenLogsFolder?: () => void
  /** 关于面板（D2：版本/形态/数据目录/日志目录/未签名/关窗即退出）。 */
  onAbout?: () => void
}

export function buildAppMenu(handlers: MenuHandlers = {}): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    { role: 'editMenu' },
    // viewMenu 内置 reload(Ctrl+R)/toggleDevTools(Ctrl+Shift+I)/zoom(Ctrl+=/-/0)：
    // 与 console 的 Ctrl+K/S/Enter 快捷键无冲突（兼容矩阵「快捷键」行的审查基线）
    { role: 'viewMenu' },
    // windowMenu 内置 close(Ctrl+W)：console 无 Ctrl+W 绑定，保留原生语义（关窗=优雅退出）
    { role: 'windowMenu' },
    {
      label: '服务',
      submenu: [
        {
          label: '进入工作台（接管 console 页面）',
          accelerator: 'Alt+Shift+W',
          enabled: handlers.onEnterWorkbench !== undefined,
          click: () => handlers.onEnterWorkbench?.(),
        },
        {
          label: '服务状态页（三服务状态与日志，钉住本页）',
          accelerator: 'Alt+Shift+S',
          enabled: handlers.onShowStartupPage !== undefined,
          click: () => handlers.onShowStartupPage?.(),
        },
        { type: 'separator' },
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
          label: '在浏览器打开 console',
          enabled: handlers.onOpenConsoleInBrowser !== undefined,
          click: () => handlers.onOpenConsoleInBrowser?.(),
        },
        { type: 'separator' },
        {
          label: '打开数据文件夹',
          enabled: handlers.onOpenDataFolder !== undefined,
          click: () => handlers.onOpenDataFolder?.(),
        },
        {
          label: '打开日志文件夹',
          enabled: handlers.onOpenLogsFolder !== undefined,
          click: () => handlers.onOpenLogsFolder?.(),
        },
        { type: 'separator' },
        {
          label: '关于 Dagents',
          enabled: handlers.onAbout !== undefined,
          click: () => handlers.onAbout?.(),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
