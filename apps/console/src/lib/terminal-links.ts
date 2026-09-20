/**
 * terminal-links.ts — 终端入口「一扇门」的唯一 href 构造点（2026-09-19
 * 双锚点设计 P1，docs/design-terminal-anchors.md §4）。
 *
 * 所有「从工作现场打开终端」的入口（运行历史失败行 / 画布失败摘要 / Chat
 * 错误卡）只准从这里拿 href —— 同一深链语义（?dir= 一次性消费 + intent 覆盖
 * 恢复偏好，见 use-shell-session boot），将来改参数名/加锚点只动这里。
 */

/** 目录锚深链：/terminal?dir=<directoryId>（意图一次性消费后从 URL 剥除）。 */
export function terminalHrefForDir(dirId: string): string {
  return `/terminal?dir=${encodeURIComponent(dirId)}`
}
