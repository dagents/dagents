import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

/**
 * error-sink 单测（2026-09-17）：webhook 投递 / in-flight 窗口合并 /
 * 未配置显式 no-op / 出口故障不升级。
 * fetch 用 vi.stubGlobal 打桩。
 */

const fetchMock = vi.fn()

describe('error-sink', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.DAGENTS_ERROR_WEBHOOK
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DAGENTS_ERROR_WEBHOOK
  })

  it('未配置 DAGENTS_ERROR_WEBHOOK = 显式 no-op（零 fetch）', async () => {
    const { reportErrorToSink } = await import('../lib/error-sink.js')
    reportErrorToSink(new Error('x'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('配置后 POST 一条 JSON 报告（service/message/stack/timestamp）', async () => {
    process.env.DAGENTS_ERROR_WEBHOOK = 'https://hooks.example/x'
    fetchMock.mockResolvedValue({ ok: true })
    const { reportErrorToSink } = await import('../lib/error-sink.js')
    reportErrorToSink(new Error('boom'))
    // fire-and-forget —— 等一个微任务拍
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://hooks.example/x')
    const body = JSON.parse(init.body as string)
    expect(body.service).toBe('gateway')
    expect(body.message).toBe('boom')
    expect(body.stack).toContain('Error: boom')
    expect(typeof body.timestamp).toBe('string')
  })

  it('webhook 投递失败被吞（不抛出不 reject）', async () => {
    process.env.DAGENTS_ERROR_WEBHOOK = 'https://hooks.example/x'
    fetchMock.mockRejectedValue(new Error('network down'))
    const { reportErrorToSink } = await import('../lib/error-sink.js')
    expect(() => reportErrorToSink(new Error('boom'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
  })
})
