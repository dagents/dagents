import { describe, expect, it, afterEach } from 'vitest'
import { DEFAULT_WS_URL, explicitWsUrl, resolveWsUrl, wsUrlOfGateway } from './ws-url'

// ws-url 单测（docs §18.5 三级解析 + R17 降级不回归）。NEXT_PUBLIC_WS_URL 的
// build 期内联语义用真实环境变量驱动（vitest node env 直改 process.env）。

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WS_URL
})

describe('wsUrlOfGateway（gateway 地址 → WS 面，单源派生）', () => {
  it('http→ws / https→wss，去尾斜杠，追加 /ws', () => {
    expect(wsUrlOfGateway('http://localhost:8080')).toBe('ws://localhost:8080/ws')
    expect(wsUrlOfGateway('http://localhost:8081/')).toBe('ws://localhost:8081/ws')
    expect(wsUrlOfGateway('http://127.0.0.1:19081//')).toBe('ws://127.0.0.1:19081/ws')
    expect(wsUrlOfGateway('https://gw.example.com')).toBe('wss://gw.example.com/ws')
  })
})

describe('explicitWsUrl（build 期内联优先通道）', () => {
  it('未设置 → null（走运行时解析）', () => {
    expect(explicitWsUrl()).toBeNull()
  })
  it('设置（含尾斜杠）→ 归一返回', () => {
    process.env.NEXT_PUBLIC_WS_URL = 'ws://e2e-gw:4010/ws/'
    expect(explicitWsUrl()).toBe('ws://e2e-gw:4010/ws')
  })
})

describe('resolveWsUrl（三级：explicit → runtime → 默认）', () => {
  it('explicit 设置时优先（不发起 fetch——e2e/自定义构建逃生门）', async () => {
    process.env.NEXT_PUBLIC_WS_URL = 'ws://explicit:1/ws'
    let fetched = false
    const url = await resolveWsUrl(async () => {
      fetched = true
      return { wsUrl: 'ws://runtime:2/ws' }
    })
    expect(url).toBe('ws://explicit:1/ws')
    expect(fetched).toBe(false)
  })

  it('runtime 返回 wsUrl → 采用（桌面让位端口经 BFF 到达浏览器）', async () => {
    expect(await resolveWsUrl(async () => ({ wsUrl: 'ws://localhost:8081/ws' }))).toBe(
      'ws://localhost:8081/ws',
    )
  })

  it('runtime 形状异常（非 ws:// 字符串/缺失）→ 默认兜底（防劫持）', async () => {
    expect(await resolveWsUrl(async () => ({ wsUrl: 'http://evil:1/ws' }))).toBe(DEFAULT_WS_URL)
    expect(await resolveWsUrl(async () => ({ gatewayUrl: 'http://x:1' }))).toBe(DEFAULT_WS_URL)
    expect(await resolveWsUrl(async () => ({ wsUrl: 42 }))).toBe(DEFAULT_WS_URL)
  })

  it('fetch 抛错 / 返回 null（不可达）→ 默认兜底（降级不回归，R17）', async () => {
    expect(
      await resolveWsUrl(async () => {
        throw new Error('fetch failed')
      }),
    ).toBe(DEFAULT_WS_URL)
    expect(await resolveWsUrl(async () => null)).toBe(DEFAULT_WS_URL)
  })

  it('默认值与改造前逐字一致（ws://localhost:8080/ws）', () => {
    expect(DEFAULT_WS_URL).toBe('ws://localhost:8080/ws')
  })
})
