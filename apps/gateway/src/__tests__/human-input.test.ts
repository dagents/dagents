import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IServerSideEventStreamer } from '@dagents/workflow'
import {
  createChatHumanInputResolver,
  createStaticHumanInputResolver,
  hasPendingHumanInput,
  resolvePendingHumanInput,
} from '../routes/human-input.js'

const mockRunQuery = vi.fn()

vi.mock('@dagents/db', () => ({
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRunQuery.mockResolvedValue({ records: [], affected: 1 })
})

afterEach(() => {
  // Drain any pending resolver so tests don't leak timers/state across files.
  resolvePendingHumanInput('chat-1', 'cleanup')
  resolvePendingHumanInput('chat-2', 'cleanup')
})

function makeStreamer() {
  return {
    streamTokenEvent: vi.fn(),
    streamEndEvent: vi.fn(),
    streamErrorEvent: vi.fn(),
    streamCustomEvent: vi.fn(),
  } satisfies IServerSideEventStreamer
}

describe('createChatHumanInputResolver', () => {
  it('parks the promise, notifies via system message + SSE, and resolves on the next message', async () => {
    const streamer = makeStreamer()
    const resolver = createChatHumanInputResolver({ chatId: 'chat-1', runId: 'r1', streamer })

    let settled: string | undefined
    const pending = resolver('请输入项目名', 'text', []).then((answer) => {
      settled = answer
    })

    expect(hasPendingHumanInput('chat-1')).toBe(true)
    // The prompt was surfaced: system message + custom SSE event.
    expect(mockRunQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockRunQuery.mock.calls[0]
    expect(sql).toContain('chat_messages')
    expect(params[1]).toContain('请输入项目名')
    expect(streamer.streamCustomEvent).toHaveBeenCalledWith(
      'chat-1',
      'human_input',
      expect.objectContaining({ prompt: '请输入项目名' }),
    )

    // Nothing settled yet, and the promise stays pending across a microtask.
    await Promise.resolve()
    expect(settled).toBeUndefined()

    // The user's next message resolves it.
    expect(resolvePendingHumanInput('chat-1', 'dagents')).toBe(true)
    expect(hasPendingHumanInput('chat-1')).toBe(false)
    await pending
    expect(settled).toBe('dagents')

    // A second resolve is a no-op (returns false).
    expect(resolvePendingHumanInput('chat-1', 'again')).toBe(false)
  })

  it('rejects when another input is already pending in the same chat', async () => {
    const resolver = createChatHumanInputResolver({ chatId: 'chat-2', runId: 'r1' })
    const first = resolver('first question', 'text', [])
    const second = resolver('second question', 'text', [])

    await expect(second).rejects.toThrow(/already waiting/)
    resolvePendingHumanInput('chat-2', 'ok')
    await expect(first).resolves.toBe('ok')
  })

  it('rejects on timeout so the run fails instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      const resolver = createChatHumanInputResolver({ chatId: 'chat-1', runId: 'r1' })
      const pending = resolver('slow question', 'text', [])

      const assertion = expect(pending).rejects.toThrow(/HumanInput timed out/)
      await vi.advanceTimersByTimeAsync(300_001)
      await assertion
      expect(hasPendingHumanInput('chat-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('formats select prompts with their options', async () => {
    const streamer = makeStreamer()
    const resolver = createChatHumanInputResolver({ chatId: 'chat-1', runId: 'r1', streamer })
    const pending = resolver('选择一个', 'select', ['red', 'blue'])
    await new Promise((r) => setTimeout(r, 0))

    const content = mockRunQuery.mock.calls[0][1][1] as string
    expect(content).toContain('选项：red / blue')
    resolvePendingHumanInput('chat-1', 'red')
    await expect(pending).resolves.toBe('red')
  })
})

describe('createStaticHumanInputResolver', () => {
  it('returns the pre-supplied answer keyed by prompt', async () => {
    const resolver = createStaticHumanInputResolver({ '你的名字？': 'Ada' })
    await expect(resolver('你的名字？', 'text', [])).resolves.toBe('Ada')
  })

  it('fails loudly when no answer was pre-supplied', async () => {
    const resolver = createStaticHumanInputResolver({})
    await expect(resolver('你的名字？', 'text', [])).rejects.toThrow(/state\.humanInputs/)
  })
})
