/**
 * cli-spawn-gate 单测（稳定性专项）：上限、FIFO 排队、槽位移交。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  acquireCliSlot,
  cliSpawnGateStats,
  resetCliSpawnGateForTest,
} from '../lib/cli-spawn-gate.js'

describe('cli-spawn-gate', () => {
  beforeEach(() => {
    vi.stubEnv('DAGENTS_MAX_CLI_PROCESSES', '2')
    resetCliSpawnGateForTest()
  })

  it('到达上限后第三次 acquire 排队，release 后按 FIFO 放行', async () => {
    const r1 = await acquireCliSlot('a')
    const r2 = await acquireCliSlot('b')
    expect(cliSpawnGateStats().active).toBe(2)

    const third = acquireCliSlot('c')
    const thirdDone = third.then((r) => {
      r() // c 拿到后立即释放，只验证接管发生
    })
    await Promise.resolve()
    expect(cliSpawnGateStats().waiting).toBe(1)

    r1() // 释放第一个槽位 → 排队者接管
    await thirdDone
    // 槽位移交：c 接了 a 的班又放掉，b 仍持有 → active 回到 1
    expect(cliSpawnGateStats().active).toBe(1)
    r2()
    expect(cliSpawnGateStats().active).toBe(0)
  })

  it('两个等待者按 FIFO 次序接管', async () => {
    vi.stubEnv('DAGENTS_MAX_CLI_PROCESSES', '1')
    resetCliSpawnGateForTest()
    const r1 = await acquireCliSlot('a')
    const order: string[] = []
    const p2 = acquireCliSlot('b').then((r) => {
      order.push('b')
      return r
    })
    const p3 = acquireCliSlot('c').then((r) => {
      order.push('c')
      return r
    })
    await Promise.resolve()
    expect(cliSpawnGateStats().waiting).toBe(2)
    r1()
    const r2 = await p2 // b 接管 a 的槽
    expect(order).toEqual(['b'])
    r2() // b 放掉 → c 接管
    const r3 = await p3
    expect(order).toEqual(['b', 'c'])
    r3()
    expect(cliSpawnGateStats().active).toBe(0)
  })

  it('release 幂等（重复调用不泄漏槽位）', async () => {
    const r = await acquireCliSlot('a')
    r()
    r()
    expect(cliSpawnGateStats().active).toBe(0)
  })

  it('等待超时不丢语义——慢等待者最终拿到槽位', async () => {
    vi.stubEnv('DAGENTS_MAX_CLI_PROCESSES', '1')
    resetCliSpawnGateForTest()
    const r1 = await acquireCliSlot('a')
    let acquired = false
    const second = acquireCliSlot('b').then((r) => {
      acquired = true
      r()
    })
    expect(acquired).toBe(false)
    r1()
    await second
    expect(acquired).toBe(true)
  })
})
