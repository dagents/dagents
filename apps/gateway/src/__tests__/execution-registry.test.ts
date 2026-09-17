import { describe, it, expect, vi } from 'vitest'
import { executionRegistry, type ExecutionHandle } from '../execution-registry.js'

/** 造一个可观测的假句柄。 */
function fakeHandle(chatId: string, runId: string): ExecutionHandle & { abortMock: ReturnType<typeof vi.fn> } {
  const abortMock = vi.fn()
  let resolveDone: () => void
  const done = new Promise<void>((r) => {
    resolveDone = r
  })
  return {
    chatId,
    runId,
    kind: 'chat-agent',
    startedAt: Date.now(),
    abort: abortMock,
    done,
    get abortMock() {
      return abortMock
    },
    ...({ settle: () => resolveDone!() } as object),
  } as ExecutionHandle & { abortMock: ReturnType<typeof vi.fn> }
}

describe('execution-registry：one-execution-per-chat（2026-09-17 修复的行为）', () => {
  it('同 chat 二次注册会 abort 旧句柄（latest-wins，旧执行不再无主并行）', () => {
    const first = fakeHandle('chat-1', 'run-1')
    executionRegistry.register(first)

    const second = fakeHandle('chat-1', 'run-2')
    executionRegistry.register(second)

    expect(first.abortMock).toHaveBeenCalledTimes(1)
    expect(second.abortMock).not.toHaveBeenCalled()
    expect(executionRegistry.getByChat('chat-1')?.runId).toBe('run-2')
    expect(executionRegistry.getByRun('run-1')).toBeUndefined()
    expect(executionRegistry.getByRun('run-2')?.runId).toBe('run-2')

    // 清场
    executionRegistry.unregister(first)
    executionRegistry.unregister(second)
  })

  it('不同 chat 互不干扰', () => {
    const a = fakeHandle('chat-a', 'run-a')
    const b = fakeHandle('chat-b', 'run-b')
    executionRegistry.register(a)
    executionRegistry.register(b)
    expect(a.abortMock).not.toHaveBeenCalled()
    executionRegistry.unregister(a)
    executionRegistry.unregister(b)
  })

  it('abortAll 触发全部句柄并返回清单（优雅停机用）', () => {
    const a = fakeHandle('chat-x', 'run-x')
    const b = fakeHandle('chat-y', 'run-y')
    executionRegistry.register(a)
    executionRegistry.register(b)
    const handles = executionRegistry.abortAll('test shutdown')
    expect(handles).toHaveLength(2)
    expect(a.abortMock).toHaveBeenCalledWith('test shutdown')
    expect(b.abortMock).toHaveBeenCalledWith('test shutdown')
    executionRegistry.unregister(a)
    executionRegistry.unregister(b)
  })
})
