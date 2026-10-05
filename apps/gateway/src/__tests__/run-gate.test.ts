/**
 * run-gate 单测（稳定性专项）：诚实 429 语义——满载拒绝不排队、release 复位。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tryAcquireRunSlot, runGateStats, resetRunGateForTest } from '../lib/run-gate.js'

describe('run-gate', () => {
  beforeEach(() => {
    vi.stubEnv('DAGENTS_MAX_CONCURRENT_RUNS', '2')
    resetRunGateForTest()
  })

  it('满载后 tryAcquire 返回 null（不排队）', () => {
    const r1 = tryAcquireRunSlot()
    const r2 = tryAcquireRunSlot()
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(tryAcquireRunSlot()).toBeNull()
    expect(tryAcquireRunSlot()).toBeNull()
    expect(runGateStats().active).toBe(2)
    r1!()
    r2!()
  })

  it('release 后槽位复位', () => {
    const r1 = tryAcquireRunSlot()
    const r2 = tryAcquireRunSlot()
    expect(tryAcquireRunSlot()).toBeNull()
    r2!()
    const r3 = tryAcquireRunSlot()
    expect(r3).not.toBeNull()
    r1!()
    r3!()
    expect(runGateStats().active).toBe(0)
  })

  it('release 幂等（重复调用不造成负数）', () => {
    const r = tryAcquireRunSlot()
    r!()
    r!()
    expect(runGateStats().active).toBe(0)
  })
})
