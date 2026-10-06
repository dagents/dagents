import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  parseWindowState,
  restoreWindowPlacement,
  type DisplayArea,
  type WindowState,
} from './window-state'

// 窗口状态记忆纯函数（体验规格 C8/C9）：解析兜底 + 显示器交集恢复 + 拔显示器回退居中。

const PRIMARY: DisplayArea = { x: 0, y: 0, width: 1920, height: 1040 }
const SECOND: DisplayArea = { x: 1920, y: 0, width: 1280, height: 720 }

function saved(over: Partial<WindowState['bounds']> = {}, extra: Partial<WindowState> = {}) {
  return {
    bounds: { x: 100, y: 80, width: 1200, height: 800, ...over },
    maximized: false,
    zoomFactor: 1,
    ...extra,
  } satisfies WindowState
}

describe('parseWindowState', () => {
  it('合法 JSON 解析 + 坐标取整', () => {
    const st = parseWindowState(
      JSON.stringify({ bounds: { x: 10.4, y: 20.6, width: 1000.2, height: 700.9 }, maximized: true, zoomFactor: 1.25 })
    )
    expect(st).toEqual({
      bounds: { x: 10, y: 21, width: 1000, height: 701 },
      maximized: true,
      zoomFactor: 1.25,
    })
  })

  it('zoomFactor 越界夹取 [0.5, 2]；缺失回落 1', () => {
    expect(parseWindowState('{"bounds":{"x":0,"y":0,"width":100,"height":100},"zoomFactor":9}')?.zoomFactor).toBe(2)
    expect(parseWindowState('{"bounds":{"x":0,"y":0,"width":100,"height":100},"zoomFactor":0.1}')?.zoomFactor).toBe(0.5)
    expect(parseWindowState('{"bounds":{"x":0,"y":0,"width":100,"height":100}}')?.zoomFactor).toBe(1)
  })

  it('坏输入（null/非 JSON/缺 bounds/NaN 坐标）一律 null，不抛', () => {
    expect(parseWindowState(null)).toBeNull()
    expect(parseWindowState('not json')).toBeNull()
    expect(parseWindowState('{"bounds":null}')).toBeNull()
    expect(parseWindowState('{"bounds":{"x":"a","y":0,"width":10,"height":10}}')).toBeNull()
    expect(parseWindowState('[]')).toBeNull()
  })
})

describe('restoreWindowPlacement', () => {
  it('无保存 → 默认尺寸主屏居中', () => {
    const r = restoreWindowPlacement(null, [PRIMARY, SECOND], PRIMARY)
    expect(r.bounds).toEqual({
      x: Math.round((1920 - DEFAULT_WIDTH) / 2),
      y: Math.round((1040 - DEFAULT_HEIGHT) / 2),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    })
    expect(r.maximized).toBe(false)
  })

  it('保存值与主屏有交集 → 原位恢复（含 maximized）', () => {
    const r = restoreWindowPlacement(saved({ x: 120, y: 60 }, { maximized: true }), [PRIMARY], PRIMARY)
    expect(r.bounds).toEqual({ x: 120, y: 60, width: 1200, height: 800 })
    expect(r.maximized).toBe(true)
  })

  it('保存值落在副屏 → 副屏原位恢复（多显示器记忆）', () => {
    const r = restoreWindowPlacement(saved({ x: 2000, y: 40 }), [PRIMARY, SECOND], PRIMARY)
    expect(r.bounds.x).toBeGreaterThanOrEqual(SECOND.x)
    expect(r.bounds.x + r.bounds.width).toBeLessThanOrEqual(SECOND.x + SECOND.width)
  })

  it('保存时的显示器已拔（无交集）→ 主屏居中回退，不丢窗（C9）', () => {
    const r = restoreWindowPlacement(saved({ x: 2000, y: 40 }), [PRIMARY], PRIMARY)
    // 居中于主屏，且尺寸夹进主屏
    expect(r.bounds).toEqual({
      x: Math.round((1920 - 1200) / 2),
      y: Math.round((1040 - 800) / 2),
      width: 1200,
      height: 800,
    })
  })

  it('保存尺寸小于最小值 → 夹回 960×640', () => {
    const r = restoreWindowPlacement(saved({ width: 400, height: 300 }), [PRIMARY], PRIMARY)
    expect(r.bounds.width).toBe(MIN_WIDTH)
    expect(r.bounds.height).toBe(MIN_HEIGHT)
  })

  it('保存尺寸大于显示器 → 夹进显示器（标题栏可见）且位置夹回屏内', () => {
    const r = restoreWindowPlacement(saved({ x: -3000, y: -2000, width: 4000, height: 3000 }), [PRIMARY], PRIMARY)
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('零显示器（防御）→ 默认居中不抛', () => {
    expect(() => restoreWindowPlacement(saved(), [], PRIMARY)).not.toThrow()
  })
})
