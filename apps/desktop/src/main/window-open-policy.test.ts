import { describe, expect, it } from 'vitest'
import {
  classifyOpenUrl,
  consoleOriginOf,
  managedChildBounds,
  type Rect,
} from './window-open-policy'

// 窗口打开三分支策略（U2，体验规格 flows 三分支）：同源→受管子窗；异源 http(s)/mailto→
// 系统浏览器；其余协议 deny。真实消费场景：form-engine.tsx:155「从广场启用 Agent」
// href="/agents?tab=plaza" target="_blank"（相对 href → 同源）。

const ORIGIN = 'http://localhost:3000'

describe('classifyOpenUrl 三分支', () => {
  it('同源（绝对与相对解析后）→ managed', () => {
    expect(classifyOpenUrl('http://localhost:3000/agents?tab=plaza', ORIGIN)).toBe('managed')
    expect(classifyOpenUrl('http://localhost:3000/', ORIGIN)).toBe('managed')
  })

  it('http(s) 异源 → external（含同机 8080/3001 网关/Langfuse——异 origin 不进子窗）', () => {
    expect(classifyOpenUrl('http://localhost:8080/health', ORIGIN)).toBe('external')
    expect(classifyOpenUrl('http://localhost:3001', ORIGIN)).toBe('external')
    expect(classifyOpenUrl('https://github.com/dagents', ORIGIN)).toBe('external')
  })

  it('mailto → external（系统默认邮件客户端）', () => {
    expect(classifyOpenUrl('mailto:a@b.c', ORIGIN)).toBe('external')
  })

  it('其余协议 → deny（file://、javascript:、about:blank、乱串）', () => {
    expect(classifyOpenUrl('file:///C:/Windows/win.ini', ORIGIN)).toBe('deny')
    expect(classifyOpenUrl('javascript:alert(1)', ORIGIN)).toBe('deny')
    expect(classifyOpenUrl('about:blank', ORIGIN)).toBe('deny')
    expect(classifyOpenUrl('not a url', ORIGIN)).toBe('deny')
  })

  it('同源但异端口不同源（:3000 vs :3000x 不存在；同 host 异 port）→ external', () => {
    expect(classifyOpenUrl('http://localhost:3001/agents', ORIGIN)).toBe('external')
  })

  it('consoleOriginOf：URL 解析失败回落原串（配置坏值防御）', () => {
    expect(consoleOriginOf('http://localhost:3000')).toBe('http://localhost:3000')
    expect(consoleOriginOf('::::')).toBe('::::')
  })
})

describe('managedChildBounds 受管子窗几何', () => {
  const parent: Rect = { x: 100, y: 80, width: 1200, height: 800 }

  it('0.8×主窗 + 首个子窗零偏移', () => {
    expect(managedChildBounds(parent, 0)).toEqual({ x: 100, y: 80, width: 960, height: 640 })
  })

  it('级联偏移 24px×已开数；第 5 个循环回位（防飘出屏幕）', () => {
    expect(managedChildBounds(parent, 1)).toEqual({ x: 124, y: 104, width: 960, height: 640 })
    expect(managedChildBounds(parent, 4)).toEqual({ x: 196, y: 176, width: 960, height: 640 })
    expect(managedChildBounds(parent, 5)).toEqual({ x: 100, y: 80, width: 960, height: 640 })
  })
})
