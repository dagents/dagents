import { describe, expect, it } from 'vitest'
import {
  classifyConsoleIdentity,
  classifyGatewayIdentity,
  extractHtmlTitle,
  probeUrl,
} from './identity'

// identity 单测（docs §18.3）：三态×两服务，响应体形状取自 §18.10 #6-#11 实测
// 真形状（陌生 200 {"ok":true} / Vite HTML / 无响应 TCP / svc:'gateway' / title 'Dagents'）。

describe('probeUrl（身份问询与健康探测同面）', () => {
  it('gateway → /health；console → 根路径', () => {
    expect(probeUrl('gateway', 8080)).toBe('http://localhost:8080/health')
    expect(probeUrl('gateway', 18080)).toBe('http://localhost:18080/health')
    expect(probeUrl('console', 3000)).toBe('http://localhost:3000/')
    expect(probeUrl('console', 3001)).toBe('http://localhost:3001/')
  })
})

describe('classifyGatewayIdentity（/health svc 特征）', () => {
  it('200 ok:up 带 svc → dagents（健康形态）', () => {
    expect(
      classifyGatewayIdentity({ status: 200, body: '{"ok":true,"svc":"gateway","db":"up"}' }),
    ).toBe('dagents')
  })

  it('503 db:down 带 svc → dagents（进程活语义——外部栈没起库不算陌生）', () => {
    expect(
      classifyGatewayIdentity({ status: 503, body: '{"ok":false,"svc":"gateway","db":"down"}' }),
    ).toBe('dagents')
  })

  it('200 {"ok":true} 无 svc → stranger（盲附加病灶形态——旧「2xx 即附加」会误判）', () => {
    expect(classifyGatewayIdentity({ status: 200, body: '{"ok":true}' })).toBe('stranger')
  })

  it('200 陌生 HTML（Vite/前端 dev server 反代）→ stranger（非 JSON）', () => {
    expect(
      classifyGatewayIdentity({ status: 200, body: '<!doctype html><title>Vite</title>' }),
    ).toBe('stranger')
  })

  it('JSON 但 svc 非 gateway → stranger', () => {
    expect(classifyGatewayIdentity({ status: 200, body: '{"svc":"other"}' })).toBe('stranger')
  })

  it('网络错 / 超时 / 无响应 TCP → stranger（安全默认）', () => {
    expect(classifyGatewayIdentity({ error: 'TimeoutError: timeout' })).toBe('stranger')
    expect(classifyGatewayIdentity({ error: 'ECONNRESET' })).toBe('stranger')
  })
})

describe('classifyConsoleIdentity（首页 title 含 Dagents 特征）', () => {
  const DAGENTS_HTML =
    '<!doctype html><html><head><meta charset="utf-8"/><title>Dagents</title></head><body></body></html>'

  it('2xx + title "Dagents" → dagents（standalone 首页实测形状）', () => {
    expect(classifyConsoleIdentity({ status: 200, body: DAGENTS_HTML })).toBe('dagents')
  })

  it('title 含 Dagents 前缀的变体 → dagents（includes 判定）', () => {
    expect(classifyConsoleIdentity({ status: 200, body: '<title>Dagents · 工作台</title>' })).toBe(
      'dagents',
    )
  })

  it('2xx 陌生 HTML（Vite/Next 形态占 3000）→ stranger', () => {
    expect(
      classifyConsoleIdentity({ status: 200, body: '<!doctype html><title>Vite + TS</title>' }),
    ).toBe('stranger')
    expect(classifyConsoleIdentity({ status: 200, body: '<!doctype html><html></html>' })).toBe(
      'stranger',
    )
  })

  it('非 2xx / 网络错 → stranger', () => {
    expect(classifyConsoleIdentity({ status: 404, body: DAGENTS_HTML })).toBe('stranger')
    expect(classifyConsoleIdentity({ status: 502, body: 'bad gateway' })).toBe('stranger')
    expect(classifyConsoleIdentity({ error: 'fetch failed' })).toBe('stranger')
  })
})

describe('extractHtmlTitle', () => {
  it('常规/带属性/多行容忍', () => {
    expect(extractHtmlTitle('<title>Dagents</title>')).toBe('Dagents')
    expect(extractHtmlTitle('<TITLE >x</TITLE>')).toBe('x')
    expect(extractHtmlTitle('noise<title data-x="1">T</title>tail')).toBe('T')
  })

  it('无 title / 空 title / 碎片 → null', () => {
    expect(extractHtmlTitle('<html></html>')).toBeNull()
    expect(extractHtmlTitle('<title></title>')).toBeNull()
    expect(extractHtmlTitle('<title>unclosed')).toBeNull()
  })
})
