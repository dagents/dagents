/**
 * llm-breaker 单测（稳定性专项）：阈值开启、冷却 half-open、成功复位。
 * 时间推进用 vi.setSystemTime（recordLlmFailure/isLlmCircuitOpen 读 Date.now）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isLlmCircuitOpen,
  recordLlmFailure,
  recordLlmSuccess,
  resetLlmBreakerForTest,
  BREAKER_COOLDOWN_MS,
} from '../lib/llm-breaker.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetLlmBreakerForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('llm-breaker', () => {
  it('阈值（默认 3）前不开启', () => {
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    expect(isLlmCircuitOpen('p1')).toBe(false)
  })

  it('连续失败达阈值 → open', () => {
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    expect(isLlmCircuitOpen('p1')).toBe(true)
  })

  it('冷却窗过后 half-open（返回 false 放探测）', () => {
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    expect(isLlmCircuitOpen('p1')).toBe(true)
    vi.setSystemTime(Date.now() + BREAKER_COOLDOWN_MS() + 1)
    expect(isLlmCircuitOpen('p1')).toBe(false)
  })

  it('half-open 探测失败 → 立即重开', () => {
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    vi.setSystemTime(Date.now() + BREAKER_COOLDOWN_MS() + 1)
    expect(isLlmCircuitOpen('p1')).toBe(false)
    // 探测失败：failures 已在阈值上，再记一笔 → 重开
    recordLlmFailure('p1')
    expect(isLlmCircuitOpen('p1')).toBe(true)
  })

  it('成功复位计数（阈值前恢复 → 不再开）', () => {
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    recordLlmSuccess('p1')
    recordLlmFailure('p1')
    expect(isLlmCircuitOpen('p1')).toBe(false)
  })

  it('各 provider 独立计数', () => {
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    recordLlmFailure('p1')
    expect(isLlmCircuitOpen('p1')).toBe(true)
    expect(isLlmCircuitOpen('p2')).toBe(false)
  })
})
