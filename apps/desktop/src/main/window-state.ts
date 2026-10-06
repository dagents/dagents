// 窗口状态记忆（体验规格 visualNotes「窗口」条 / 验收 C8 C9）：
//   window-state.json 记忆 bounds + maximized + zoomFactor，重启恢复；
//   恢复时与 getAllDisplays() workArea 求交集——保存时的显示器已被拔掉则回退
//   主屏居中（不丢窗）；最小 960×640；缩放持久化（Ctrl+= 调档跨重启保留）。
// 纯逻辑（禁 import electron——同 orchestrator/ 纪律，单测全速驱动）；
// Electron 接线（fs 持久化/screen/display 求交）在 windows.ts 薄壳。

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: WindowBounds
  maximized: boolean
  zoomFactor: number
}

/** 与 Electron Display.workArea 同构的最小面（纯函数可测）。 */
export interface DisplayArea {
  x: number
  y: number
  width: number
  height: number
}

export const MIN_WIDTH = 960
export const MIN_HEIGHT = 640
export const DEFAULT_WIDTH = 1440
export const DEFAULT_HEIGHT = 900
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const DEFAULT_ZOOM = 1

/** 解析持久化 JSON；任何形状/类型异常 → null（回落全新默认窗口，永不抛出）。 */
export function parseWindowState(raw: string | null): WindowState | null {
  if (raw === null) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const b = o.bounds
  if (b === null || typeof b !== 'object') return null
  const bounds = b as Record<string, unknown>
  const coords = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!coords.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return {
    bounds: {
      x: Math.round(coords[0] as number),
      y: Math.round(coords[1] as number),
      width: Math.round(coords[2] as number),
      height: Math.round(coords[3] as number),
    },
    maximized: o.maximized === true,
    zoomFactor:
      typeof o.zoomFactor === 'number' && Number.isFinite(o.zoomFactor)
        ? Math.min(Math.max(o.zoomFactor, ZOOM_MIN), ZOOM_MAX)
        : DEFAULT_ZOOM,
  }
}

function intersects(a: WindowBounds, d: DisplayArea): boolean {
  return (
    a.x < d.x + d.width &&
    a.x + a.width > d.x &&
    a.y < d.y + d.height &&
    a.y + a.height > d.y
  )
}

function centered(area: DisplayArea, width: number, height: number): WindowBounds {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

/**
 * 恢复落位：保存 bounds 与某块显示器 workArea 有交集 → 用保存值（尺寸夹进
 * [MIN, workArea]、位置夹回该显示器内，保证标题栏可见）；无交集（显示器已拔）→
 * 主屏 workArea 居中回退。无保存值 → 默认尺寸主屏居中。
 */
export function restoreWindowPlacement(
  saved: WindowState | null,
  displays: DisplayArea[],
  primary: DisplayArea
): { bounds: WindowBounds; maximized: boolean } {
  const fallback = () => ({
    bounds: centered(
      primary,
      Math.min(DEFAULT_WIDTH, primary.width),
      Math.min(DEFAULT_HEIGHT, primary.height)
    ),
    maximized: false,
  })
  if (saved === null || displays.length === 0) return fallback()

  const hit = displays.find((d) => intersects(saved.bounds, d))
  if (hit === undefined) {
    // 保存时的显示器已被拔掉：主屏居中回退（尺寸夹进主屏），不丢窗（C9）
    return {
      bounds: centered(
        primary,
        Math.min(Math.max(saved.bounds.width, MIN_WIDTH), Math.max(primary.width, MIN_WIDTH)),
        Math.min(Math.max(saved.bounds.height, MIN_HEIGHT), Math.max(primary.height, MIN_HEIGHT))
      ),
      maximized: saved.maximized,
    }
  }
  const width = Math.min(Math.max(saved.bounds.width, MIN_WIDTH), Math.max(hit.width, MIN_WIDTH))
  const height = Math.min(
    Math.max(saved.bounds.height, MIN_HEIGHT),
    Math.max(hit.height, MIN_HEIGHT)
  )
  // 位置夹回命中显示器内（宽/高取 display 与保存值较小者，防比屏还大被裁掉标题栏）
  const fitW = Math.min(width, hit.width)
  const fitH = Math.min(height, hit.height)
  const x = Math.min(Math.max(saved.bounds.x, hit.x), hit.x + hit.width - fitW)
  const y = Math.min(Math.max(saved.bounds.y, hit.y), hit.y + hit.height - fitH)
  return {
    bounds: { x: Math.round(x), y: Math.round(y), width: fitW, height: fitH },
    maximized: saved.maximized,
  }
}
