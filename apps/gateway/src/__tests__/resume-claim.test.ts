import { describe, it, expect } from 'vitest'
import { claimCheckpointRun, releaseCheckpointRun } from '../routes/resume-execution.js'

/**
 * resume 认领互斥原语（架构优化轮 2026-09-19 回归锚）：
 * checkpointRunId 维度的进程内 mutex。路由层的泄漏修复（G1 校验前置 +
 * 失败显式 release、G6 answer 路由认领）依赖这里的 check-then-act 语义。
 * 纯内存无 DB —— import 链上的模块副作用与既有测试同域，已验证安全。
 */
describe('resume 认领互斥原语', () => {
  it('认领 → 二次认领被拒 → 释放后可重新认领', () => {
    const runId = `11111111-1111-4111-8111-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`
    expect(claimCheckpointRun(runId)).toBe(true)
    expect(claimCheckpointRun(runId)).toBe(false)
    releaseCheckpointRun(runId)
    expect(claimCheckpointRun(runId)).toBe(true)
    releaseCheckpointRun(runId)
  })

  it('未认领的 run 直接释放是无害 no-op（路由早退路径的安全网）', () => {
    const runId = '22222222-2222-4222-8222-000000000000'
    expect(() => releaseCheckpointRun(runId)).not.toThrow()
    expect(claimCheckpointRun(runId)).toBe(true)
    releaseCheckpointRun(runId)
  })
})
