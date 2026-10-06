import { Menu, type MenuItemConstructorOptions } from 'electron'

// 全 role 化基础菜单（mac 没有基础菜单连复制粘贴都没有）+ 自定义「服务」菜单占位。
// 「服务」菜单的四个动作（重启服务 / 停止服务 / 打开启动态页 / 在浏览器打开 console）
// 由 M2 编排器 + IPC 桥接线后启用 —— docs/desktop-architecture.md §3.4。
export function buildAppMenu(): void {
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
        { label: '重启服务（M2 接入编排器后启用）', enabled: false },
        { label: '停止服务（M2 接入编排器后启用）', enabled: false },
        { type: 'separator' },
        { label: '打开启动态页（M3 接入）', enabled: false },
        { label: '在浏览器打开 console（M3 接入）', enabled: false },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
