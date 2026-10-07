import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { probePort, waitForPortRelease } from './ports'

// 真网络单测（设计 §6）：起真 listener（port 0 让内核分配）测探测——
// guard-build.mjs 同款 socket 手法，无 mock。

describe('probePort', () => {
  it('listener 在听 → true；关闭 → false', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      expect(await probePort(port)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(await probePort(port)).toBe(false)
  })

  it('无人监听的高位端口 → false（快失败）', async () => {
    // 49xxx 段基本无人占用；探测本身 300ms 超时兜底
    expect(await probePort(49871)).toBe(false)
  })
})

describe('waitForPortRelease', () => {
  it('listener 关闭后释放成功', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await waitForPortRelease(port, 2000)).toBe(true)
  })

  it('listener 一直占着 → 超时返回 false（停止验收的告警路径）', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      expect(await waitForPortRelease(port, 900, 200)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
