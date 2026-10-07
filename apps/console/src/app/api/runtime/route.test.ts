import { describe, it, expect, afterEach } from 'vitest'
import { GET, dynamic } from './route'

// /api/runtime 单测（docs §18.5）：GATEWAY_URL 派生 wsUrl/gatewayUrl + 拔
// GATEWAY_URL 的默认回落（降级不回归）+ force-dynamic 契约（运行时语义不得缓存）。

afterEach(() => {
  delete process.env.GATEWAY_URL
})

describe('GET /api/runtime', () => {
  it('GATEWAY_URL 已设 → 返回实际地址与派生 wsUrl（桌面让位端口到达浏览器）', async () => {
    process.env.GATEWAY_URL = 'http://localhost:8081'
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { gatewayUrl: string; wsUrl: string }
    expect(body.gatewayUrl).toBe('http://localhost:8081')
    expect(body.wsUrl).toBe('ws://localhost:8081/ws')
  })

  it('GATEWAY_URL 带尾斜杠 → 归一（复用 gatewayUrl 通道语义）', async () => {
    process.env.GATEWAY_URL = 'http://127.0.0.1:19081/'
    const body = (await (await GET()).json()) as { gatewayUrl: string; wsUrl: string }
    expect(body.gatewayUrl).toBe('http://127.0.0.1:19081')
    expect(body.wsUrl).toBe('ws://127.0.0.1:19081/ws')
  })

  it('拔 GATEWAY_URL → 默认 8080（dev/e2e 行为零变化，降级不回归）', async () => {
    const body = (await (await GET()).json()) as { gatewayUrl: string; wsUrl: string }
    expect(body.gatewayUrl).toBe('http://localhost:8080')
    expect(body.wsUrl).toBe('ws://localhost:8080/ws')
  })
})

describe('缓存契约', () => {
  it('force-dynamic（端口语义是运行时的，绝不能 build 期缓存）', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
