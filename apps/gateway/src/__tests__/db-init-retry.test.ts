/**
 * db-init-retry 单测（稳定性专项）：预算内重试到成功；预算耗尽如实抛。
 */

import { describe, it, expect } from 'vitest'
import { retryUntilDeadline } from '../lib/db-init-retry.js'

describe('retryUntilDeadline', () => {
  it('前两次失败第三次成功 → 返回结果', async () => {
    let calls = 0
    const out = await retryUntilDeadline(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('db down')
        return 'up'
      },
      { deadlineMs: 5_000, baseDelayMs: 1, maxDelayMs: 2 },
    )
    expect(out).toBe('up')
    expect(calls).toBe(3)
  })

  it('预算耗尽 → 抛最后一次错误', async () => {
    let calls = 0
    await expect(
      retryUntilDeadline(
        async () => {
          calls += 1
          throw new Error(`failure ${calls}`)
        },
        { deadlineMs: 50, baseDelayMs: 10, maxDelayMs: 20 },
      ),
    ).rejects.toThrow('failure ')
    expect(calls).toBeGreaterThan(1)
  })

  it('首次即成功不重试', async () => {
    let calls = 0
    const out = await retryUntilDeadline(
      async () => {
        calls += 1
        return 42
      },
      { deadlineMs: 1_000, baseDelayMs: 1 },
    )
    expect(out).toBe(42)
    expect(calls).toBe(1)
  })

  it('onRetry 回调携带尝试序号与延迟', async () => {
    const seen: Array<{ attempt: number; delayMs: number }> = []
    let calls = 0
    await retryUntilDeadline(
      async () => {
        calls += 1
        if (calls < 2) throw new Error('once')
        return null
      },
      {
        deadlineMs: 5_000,
        baseDelayMs: 5,
        maxDelayMs: 10,
        onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
      },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].attempt).toBe(1)
    expect(seen[0].delayMs).toBeGreaterThan(0)
  })
})
