// 窗口打开三分支策略（体验规格 flows「外部链接与新窗口三分支」，U2 痛点②）——纯逻辑：
//   managed  = origin 与 consoleUrl 同源（如 form-engine.tsx:155「从广场启用 Agent」
//              href="/agents?tab=plaza" target="_blank"）→ 受管子窗（继承 preload、
//              0.8×主窗、24px 级联偏移；title 随页面文档——C15）
//   external = 其他一切 http(s)/mailto（含 localhost:8080/:3001 同机异 origin）→ 系统浏览器
//   deny     = 其余协议（file://、javascript:、about: 等）
// Electron 接线在 index.ts（setWindowOpenHandler + browser-window-created 追踪 +
// 主窗 close 逐个 destroy——A6 子窗随主窗关闭，否则 window-all-closed 等子窗全关才触发）。

export type OpenUrlDecision = 'managed' | 'external' | 'deny'

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function consoleOriginOf(consoleUrl: string): string {
  return originOf(consoleUrl) ?? consoleUrl
}

/** 三分支判定（setWindowOpenHandler 单点消费）。 */
export function classifyOpenUrl(url: string, consoleOrigin: string): OpenUrlDecision {
  const origin = originOf(url)
  if (origin !== null && origin === consoleOrigin) return 'managed'
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return 'external'
  return 'deny'
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const MANAGED_CHILD_SCALE = 0.8
/** 级联偏移步长（px）；到第 5 个循环回位防飘出屏幕。 */
export const MANAGED_CHILD_CASCADE_STEP = 24
const MANAGED_CHILD_MAX_CASCADE = 5

/**
 * 受管子窗几何：0.8×主窗正常态尺寸；从主窗左上角起按已开子窗数级联偏移 24px
 * （i%5 循环）。纯函数可测；真实主窗 bounds 由接线层传入。
 */
export function managedChildBounds(parent: Rect, alreadyOpen: number): Rect {
  const offset = (alreadyOpen % MANAGED_CHILD_MAX_CASCADE) * MANAGED_CHILD_CASCADE_STEP
  return {
    x: Math.round(parent.x + offset),
    y: Math.round(parent.y + offset),
    width: Math.round(parent.width * MANAGED_CHILD_SCALE),
    height: Math.round(parent.height * MANAGED_CHILD_SCALE),
  }
}
