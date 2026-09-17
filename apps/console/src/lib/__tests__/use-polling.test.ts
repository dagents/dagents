import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolling } from '@/lib/use-polling'

/** jsdom 的 document.hidden 只读 —— 用 defineProperty 打桩。 */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('挂载立即执行一轮，之后按 intervalMs 排程；fetcher false 即停', async () => {
    const fetcher = vi.fn(async () => true)
    renderHook(() => usePolling(fetcher, { intervalMs: 1000 }))
    // 首轮立即执行（微任务 flush）
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(3)

    fetcher.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    // 返回 false 后不再排下一轮
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('fetcher 为 null 时不轮询；从 null 变非 null 时启动', async () => {
    const fetcher = vi.fn(async () => false)
    const { rerender } = renderHook(({ on }: { on: boolean }) => usePolling(on ? fetcher : null, { intervalMs: 1000 }), {
      initialProps: { on: false },
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetcher).not.toHaveBeenCalled()
    rerender({ on: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fetcher 身份变化不打断循环（每轮取最新闭包，不重入）', async () => {
    let calls = 0
    const make = (): (() => Promise<boolean>) => async () => {
      calls++
      return true
    }
    const { rerender } = renderHook((_props: { unused?: boolean }) => usePolling(make(), { intervalMs: 1000 }), {
      initialProps: {},
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    rerender({})
    await vi.advanceTimersByTimeAsync(0)
    // 新 fetcher 身份不触发立即重入
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
  })

  it('restartKey 变化清掉在途定时器并立即补一轮', async () => {
    const fetcher = vi.fn(async () => true)
    const { rerender } = renderHook(
      ({ key }: { key: number }) => usePolling(fetcher, { intervalMs: 5000, restartKey: key }),
      { initialProps: { key: 1 } },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    rerender({ key: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // 重入后从当前时刻重新按 interval 排程
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('visibilityPause：隐藏期间不发起下一轮，重新可见立即补轮', async () => {
    const fetcher = vi.fn(async () => true)
    renderHook(() => usePolling(fetcher, { intervalMs: 1000, visibilityPause: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    setHidden(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(1) // 隐藏 → 不排轮
    setHidden(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2) // 可见 → 立即补轮
  })

  it('抛错按继续处理；配 backoffMaxMs 时间隔翻倍至上限、成功后复位', async () => {
    let fail = true
    const fetcher = vi.fn(async (): Promise<boolean> => {
      if (fail) throw new Error('boom')
      return false
    })
    renderHook(() => usePolling(fetcher, { intervalMs: 1000, backoffMaxMs: 4000 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1) // t=0 抛错 → 间隔翻倍到 2000
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // t=2000 抛错 → 间隔翻倍到 4000（封顶）
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fail = false
    await vi.advanceTimersByTimeAsync(1) // t=6000 成功且返回 false → 停
    expect(fetcher).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('卸载清理：不再发起后续轮次', async () => {
    const fetcher = vi.fn(async () => true)
    const { unmount } = renderHook(() => usePolling(fetcher, { intervalMs: 1000 }))
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
