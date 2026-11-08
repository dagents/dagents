/**
 * 可恢复性 R3/R8 单源单测（design-recover §⑥）：
 *  - toRunStatus 写新翻转（AC-R3-3：cancelled→stopped(user/superseded)，三
 *    入口共用单源）；
 *  - classifyAbortReason（R3.2：superseded 判定 = abort reason 字符串）；
 *  - classifyFailureReason（R3.2：providerFailure → provider，默认 model）；
 *  - deriveSessionId 确定性（AC-R8-1：同键同 id、异 run 异 id、寻址键口径）。
 */
import { describe, expect, it } from 'vitest'
import {
  toRunStatus,
  classifyAbortReason,
  classifyFailureReason,
} from '../routes/workflow-engine-service.js'
import { deriveSessionId } from '../routes/workflow-clients.js'

describe('toRunStatus（R3 单源，AC-R3-3）', () => {
  it('cancelled → stopped(user)（写新；存量 cancelled 行读侧双读，不迁移）', () => {
    expect(toRunStatus('cancelled')).toEqual({ status: 'stopped', stopReason: 'user' })
  })

  it('cancelled + superseded → stopped(superseded)', () => {
    expect(toRunStatus('cancelled', { superseded: true })).toEqual({
      status: 'stopped',
      stopReason: 'superseded',
    })
  })

  it('其余状态映射不变（success/partial/budget/failed）', () => {
    expect(toRunStatus('success')).toEqual({ status: 'completed' })
    expect(toRunStatus('partial_success')).toEqual({ status: 'partial_success' })
    expect(toRunStatus('budget_exceeded')).toEqual({ status: 'budget_exceeded' })
    expect(toRunStatus('whatever')).toEqual({ status: 'failed' })
  })
})

describe('classifyAbortReason（R3.2 归属单源）', () => {
  it('execution-registry 的 superseded abort 串 → superseded', () => {
    const ctl = new AbortController()
    ctl.abort(new Error('superseded by a new execution in this chat'))
    expect(classifyAbortReason(ctl.signal)).toBe('superseded')
  })

  it('用户取消 / 未中止 → user', () => {
    const user = new AbortController()
    user.abort(new Error('cancelled by caller'))
    expect(classifyAbortReason(user.signal)).toBe('user')
    expect(classifyAbortReason(undefined)).toBe('user')
    expect(classifyAbortReason(new AbortController().signal)).toBe('user')
  })
})

describe('classifyFailureReason（R3.2：failed 行归属）', () => {
  it('providerFailure: true → provider（pin 拒绝降级，R8.4 错误对象）', () => {
    const err = new Error('boom') as Error & { providerFailure?: boolean }
    err.providerFailure = true
    expect(classifyFailureReason(err)).toBe('provider')
  })

  it('默认 → model（引擎/模型错误）', () => {
    expect(classifyFailureReason(new Error('engine'))).toBe('model')
    expect(classifyFailureReason(null)).toBe('model')
  })
})

describe('deriveSessionId（R8 寻址键，AC-R8-1）', () => {
  it('同键同 id（确定性——公式可单测预测）', () => {
    expect(deriveSessionId('run-1', 'nodeA', 0)).toBe(deriveSessionId('run-1', 'nodeA', 0))
    expect(deriveSessionId('run-1', 'nodeA', 2)).toBe(deriveSessionId('run-1', 'nodeA', 2))
  })

  it('异 run / 异 node / 异 ordinal → 异 id', () => {
    const base = deriveSessionId('run-1', 'nodeA', 0)
    expect(deriveSessionId('run-2', 'nodeA', 0)).not.toBe(base)
    expect(deriveSessionId('run-1', 'nodeB', 0)).not.toBe(base)
    expect(deriveSessionId('run-1', 'nodeA', 1)).not.toBe(base)
  })

  it('输出形状：SHA-1 前 16 hex（寻址键——绝不进 ExecOptions.resumeSessionId）', () => {
    expect(deriveSessionId('r', 'n', 0)).toMatch(/^[0-9a-f]{16}$/)
  })
})
