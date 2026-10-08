/**
 * run-status.ts 单测（design-recover §4.1，R3.6 词汇单点）：
 * 四消费点共用的终态判定/标签映射/停止来源派生——词表漂移的防回归钉
 * （九态与 DB CHECK/TS RunStatus 同源；cancelled 双读兼容期）。
 */
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  STATUS_LABEL,
  STOP_REASON_LABEL,
  stoppedStatusLabel,
} from './run-status'

describe('isTerminalRunStatus（终态判定，双读 stopped+cancelled）', () => {
  it('六个终态词全部命中（词表全集：awaiting_input 是挂起非终态）', () => {
    for (const s of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(s)).toBe(true)
    }
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      [
        'cancelled',
        'budget_exceeded',
        'completed',
        'failed',
        'partial_success',
        'stopped',
      ].sort(),
    )
  })

  it('非终态与空值不命中（轮询继续的三态 + null/undefined 容错）', () => {
    for (const s of ['pending', 'running', 'awaiting_input']) {
      expect(isTerminalRunStatus(s)).toBe(false)
    }
    expect(isTerminalRunStatus(null)).toBe(false)
    expect(isTerminalRunStatus(undefined)).toBe(false)
    expect(isTerminalRunStatus('')).toBe(false)
  })
})

describe('STATUS_LABEL（九态标签——自然键 = i18n key）', () => {
  it('九态全覆盖（与 DB CHECK 词表同源，缺词回退中文原样不炸）', () => {
    const nineStates = [
      'pending',
      'running',
      'awaiting_input',
      'completed',
      'partial_success',
      'budget_exceeded',
      'failed',
      'stopped',
      'cancelled',
    ]
    for (const s of nineStates) {
      expect(STATUS_LABEL[s], `词表 ${s} 应有标签`).toBeTruthy()
    }
    // 写新读旧的双读基词（AC-R3-4：两者可区分）
    expect(STATUS_LABEL['stopped']).toBe('已停止')
    expect(STATUS_LABEL['cancelled']).toBe('已取消')
    // 未知词回落原样（防御）
    expect(STATUS_LABEL['bogus'] ?? 'bogus').toBe('bogus')
  })
})

describe('stoppedStatusLabel（stopped 细分派生，§4.1 第 2 点）', () => {
  it('interrupted + resumable → 「已中断（可恢复）」（AC-R1-6 入口联动文案）', () => {
    expect(stoppedStatusLabel('interrupted', true)).toBe('已中断（可恢复）')
  })

  it('interrupted 无 checkpoint → 「已中断」（不渲染恢复入口的诚实态）', () => {
    expect(stoppedStatusLabel('interrupted', false)).toBe('已中断')
  })

  it('user → 「已停止」（中性色，非失败红——AC-R3-4 与 failed 可区分）', () => {
    expect(stoppedStatusLabel('user', false)).toBe('已停止')
  })

  it('未知/缺席来源回落「已停止」基词', () => {
    expect(stoppedStatusLabel(null, false)).toBe('已停止')
    expect(stoppedStatusLabel(undefined, true)).toBe('已停止')
    expect(stoppedStatusLabel('superseded', false)).toBe('已停止')
  })
})

describe('STOP_REASON_LABEL（五值词表，R3.2 无死值）', () => {
  it('五值全覆盖（user/interrupted/superseded/model/provider）', () => {
    expect(Object.keys(STOP_REASON_LABEL).sort()).toEqual(
      ['interrupted', 'model', 'provider', 'superseded', 'user'].sort(),
    )
  })
})
