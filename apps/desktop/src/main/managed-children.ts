import type { BrowserWindow } from 'electron'

// 受管子窗生命周期（U2，体验规格 A6/C2/C15）：
//   同源 window.open → 受管子窗（setWindowOpenHandler allow 分支），登记于此；
//   主窗 close → destroyManagedChildren() 逐个 destroy——否则 window-all-closed 要等
//   子窗全关才触发，主窗关了应用不退、服务栈继续跑，违背「关窗即优雅退出」（A6）。
// 追踪用「放行计数 → 下一个 browser-window-created 认领」握手：主窗/devtools 创建时
// 计数为 0，不会被误收。

const children = new Set<BrowserWindow>()
let expecting = 0

/** setWindowOpenHandler 放行 managed 分支时调用（即将有一个子窗出生）。 */
export function expectManagedChild(): void {
  expecting++
}

/** browser-window-created 时认领：若在等受管子窗则登记并返回 true（closed 自摘除）。 */
export function claimManagedChild(win: BrowserWindow): boolean {
  if (expecting <= 0) return false
  expecting--
  children.add(win)
  win.once('closed', () => children.delete(win))
  return true
}

/** 当前在开受管子窗数（级联偏移参数）。 */
export function managedChildCount(): number {
  return children.size
}

/** 主窗 close 时全量销毁（destroy 不走各窗 close 钩子，直接拆）。 */
export function destroyManagedChildren(): void {
  for (const child of children) {
    if (!child.isDestroyed()) child.destroy()
  }
  children.clear()
}
