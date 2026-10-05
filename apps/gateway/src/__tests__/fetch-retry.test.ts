/**
 * fetch-retry 单测（稳定性专项 2026-10-04）：瞬时故障重试的分类学——
 * 429/5xx 重试、4xx 直通、外部取消立即中断、网络错误重试后成功。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchWithRetry,
  isRetryableStatus,
  isTransientFetchError,
  parseRetryAfterMs,
  backoffDelayMs,
} from '../lib/fetch-retry.js'

const okResponse = (): Response => new Response('{"ok":true}', { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isRetryableStatus', () => {
  it('429/5xx 可重试，其余直通', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true)
    for (const s of [200, 400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false)
  })
})

describe('isTransientFetchError', () => {
  it('TypeError（fetch failed）与 TimeoutError 判瞬时', () => {
    expect(isTransientFetchError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientFetchError(new DOMException('signal timed out', 'TimeoutError'))).toBe(true)
  })

  it('普通 Error 不判瞬时', () => {
    expect(isTransientFetchError(new Error('boom'))).toBe(false)
  })

  it('cause 携带 ECONNRESET 等码判瞬时', () => {
    const err = new TypeError('fetch failed') as TypeError & { cause: { code: string } }
    err.cause = { code: 'ECONNRESET' }
    expect(isTransientFetchError(err)).toBe(true)
  })
})

describe('parseRetryAfterMs', () => {
  it('整数秒 → 毫秒', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
  })
  it('HTTP-Date → 正差值', () => {
    const future = new Date(Date.now() + 5000).toUTCString()
    const ms = parseRetryAfterMs(future)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThan(4000)
  })
  it('非法值 → null', () => {
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('指数增长并封顶', () => {
    const noJitter = (v: number) => v // 只验证边界：jitter 上下 30% 内
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(1, 100, 1000)
      expect(d).toBeGreaterThanOrEqual(70)
      expect(d).toBeLessThanOrEqual(130)
      void noJitter
    }
    expect(backoffDelayMs(10, 100, 1000)).toBeLessThanOrEqual(1000)
  })
})

describe('fetchWithRetry', () => {
  it('5xx 两次后 200 —— 重试拿到成功响应', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry('http://x', {}, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('401 配置错误直通不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry('http://x', {}, { attempts: 3, baseDelayMs: 1 })
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('网络错误重试后成功', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry('http://x', {}, { attempts: 3, baseDelayMs: 1 })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('外部 signal 已取消 → 立即抛出不重试', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await expect(
      fetchWithRetry('http://x', {}, { attempts: 3, signal: controller.signal, baseDelayMs: 1 }),
    ).rejects.toThrow()
    // fetch 都不该被调用（外部 signal 组合进请求前已 aborted —— fetch 会抛）
  })

  it('外部 signal 在退避期间取消 → 中断重试链', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation(() => {
      // 第一次返回 502 触发退避；退避中取消
      setTimeout(() => controller.abort(new Error('cancelled mid-backoff')), 1)
      return Promise.resolve(new Response('err', { status: 502 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchWithRetry('http://x', {}, { attempts: 3, signal: controller.signal, baseDelayMs: 50 }),
    ).rejects.toThrow('cancelled mid-backoff')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('可重试状态耗尽 → 返回最后一次响应（调用方决定呈现）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('err', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry('http://x', {}, { attempts: 2, baseDelayMs: 1 })
    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
