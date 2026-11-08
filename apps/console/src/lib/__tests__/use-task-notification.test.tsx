/**
 * useTaskNotification.notifyOnRunUpdated 单测（R9b 客户端半，design-sharp
 * §6.5：AC-R3-6 最小阶段的过滤函数 + AC-R9-3 的跨标签页 claim）。
 *
 * 副作用面：toast（真 ToastProvider 渲染进 DOM 断言）+ 声音（vi.mock）+
 * 桌面通知（jsdom 无 Notification API，showDesktop 的 try/catch 已按平台
 * 缺席降级到 toast——本文件不桩 Notification，桌面分支天然走兜底）。
 * 跨标签页 claim 用**真 BroadcastChannel**（Node 全局：同进程实例间互投，
 * 与浏览器同源语义一致）；本环境该 API 存在（设计预判「jsdom 无」已过时，
 * 见 run-notify-claim.test.ts 头注释）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTaskNotification } from '@/lib/use-task-notification'
import { resetRunNotifyClaimForTests, sharedRunNotifyClaim } from '@/lib/run-notify-claim'
import { playSuccessSound, playErrorSound } from '@/lib/notification-sound'
import { ToastProvider } from '@/components/toast'
import { I18nProvider } from '@/i18n'

vi.mock('@/lib/notification-sound', () => ({
  playSuccessSound: vi.fn(),
  playErrorSound: vi.fn(),
}))

/** 包 ToastProvider + I18nProvider 的渲染（toast.success/error 落 DOM 才可断言）。 */
function renderNotifier() {
  return renderHook(() => useTaskNotification({ chatId: null, chatTitle: null }), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    ),
  })
}

const terminalFrame = (
  overrides: Partial<
    Parameters<ReturnType<typeof useTaskNotification>['notifyOnRunUpdated']>[0]
  > = {},
) => ({
  type: 'run-updated' as const,
  runId: 'run-notify-test',
  status: 'completed',
  ...overrides,
})

async function flushBroadcast(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
}

describe('notifyOnRunUpdated（R9b 客户端半）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRunNotifyClaimForTests()
    localStorage.removeItem('dagents:notification-settings')
    document.querySelectorAll('.toast-item').forEach((el) => el.remove())
  })
  afterEach(() => {
    resetRunNotifyClaimForTests()
  })

  it('终态 completed → 成功 toast + 成功声音（正文含 runId 短码与状态词）', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnRunUpdated(terminalFrame({ runId: 'abcd1234-0000' }))
    await waitFor(() => {
      expect(playSuccessSound).toHaveBeenCalledTimes(1)
    })
    expect(playErrorSound).not.toHaveBeenCalled()
    const msg = document.querySelector('.toast-item .toast-message')?.textContent ?? ''
    expect(msg).toContain('abcd1234')
    expect(msg).toContain('已完成')
  })

  it('failed → 失败 toast + 失败声音', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnRunUpdated(terminalFrame({ status: 'failed' }))
    await waitFor(() => {
      expect(playErrorSound).toHaveBeenCalledTimes(1)
    })
    expect(playSuccessSound).not.toHaveBeenCalled()
    const msg = document.querySelector('.toast-item .toast-message')?.textContent ?? ''
    expect(msg).toContain('失败')
  })

  it('superseded 帧零通知（AC-R3-6 最小实现客户端路径）', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnRunUpdated(
      terminalFrame({ status: 'stopped', stopReason: 'superseded' }),
    )
    await flushBroadcast()
    expect(playSuccessSound).not.toHaveBeenCalled()
    expect(playErrorSound).not.toHaveBeenCalled()
    expect(document.querySelector('.toast-item')).toBeNull()
  })

  it('非终态（awaiting_input/running）零通知', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnRunUpdated(terminalFrame({ status: 'awaiting_input' }))
    result.current.notifyOnRunUpdated(terminalFrame({ status: 'running' }))
    await flushBroadcast()
    expect(playSuccessSound).not.toHaveBeenCalled()
    expect(playErrorSound).not.toHaveBeenCalled()
    expect(document.querySelector('.toast-item')).toBeNull()
  })

  it('同 runId 重复帧只通知一次（claim 幂等）；不同 runId 各自通知', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnRunUpdated(terminalFrame({ runId: 'run-once' }))
    result.current.notifyOnRunUpdated(terminalFrame({ runId: 'run-once' }))
    result.current.notifyOnRunUpdated(terminalFrame({ runId: 'run-twice', status: 'failed' }))
    await waitFor(() => {
      expect(playSuccessSound).toHaveBeenCalledTimes(1)
      expect(playErrorSound).toHaveBeenCalledTimes(1)
    })
    // 三个 toast 不会出现：run-once 幂等合并为 1
    await flushBroadcast()
    const messages = [...document.querySelectorAll('.toast-item .toast-message')].map(
      (el) => el.textContent ?? '',
    )
    expect(messages.filter((m) => m.includes('run-once'.slice(0, 8)))).toHaveLength(1)
  })

  it('跨标签页 claim：他页已 claim 的 runId 静默（真 BroadcastChannel 互投）', async () => {
    // 先物化本页的 claim 单例（惰性创建——否则监听者晚于他页消息），
    // 再模拟另一标签页 claim：同进程同频道真实例 postMessage。
    sharedRunNotifyClaim()
    const otherTab = new BroadcastChannel('dagents:run-notify')
    otherTab.postMessage({ type: 'claim', runId: 'run-claimed-elsewhere' })
    await flushBroadcast()
    otherTab.close()

    const { result } = renderNotifier()
    result.current.notifyOnRunUpdated(terminalFrame({ runId: 'run-claimed-elsewhere' }))
    await flushBroadcast()
    expect(playSuccessSound).not.toHaveBeenCalled()
    expect(playErrorSound).not.toHaveBeenCalled()
    expect(document.querySelector('.toast-item')).toBeNull()
  })
})

// ── 可恢复性 R3.6（design-recover §4.4，AC-R3-6 最小实现的 chat 帧半）──
// notifyOnFrame 的 superseded 早退：chat:done / chat:error / chat:cancelled
// 终态帧携带 stopReason='superseded' 时零通知（toast/声音/桌面全链）；同形状
// 无 stopReason 的帧正常通知（对照）；非 superseded 来源（user）不误伤。
// sharp 的上方 describe 钉的是 run-updated 半（R9b），本段钉 chat WS 帧——
// 设计原文「实弹验证面 = chat 路径通知链 + 画布 toast 链」的前者。
describe('notifyOnFrame：chat 帧 superseded 抑制（可恢复性 AC-R3-6）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRunNotifyClaimForTests()
    localStorage.removeItem('dagents:notification-settings')
    document.querySelectorAll('.toast-item').forEach((el) => el.remove())
  })

  /** chat 终态帧（chatId 不同于挂载 chat → shouldNotify 成立）。 */
  const chatFrame = (over: {
    type: 'chat:done' | 'chat:error' | 'chat:cancelled'
    stopReason?: string
  }) =>
    ({
      type: over.type,
      chatId: 'chat-somewhere-else',
      runId: 'run-recover-1',
      role: 'assistant',
      content: over.type === 'chat:done' ? '正文' : '（已取消）',
      streaming: false,
      ...(over.type === 'chat:error' ? { error: 'boom' } : {}),
      ...(over.type === 'chat:cancelled' ? { reason: 'superseded by a new execution' } : {}),
      ...(over.stopReason != null ? { stopReason: over.stopReason } : {}),
    }) as Parameters<ReturnType<typeof useTaskNotification>['notifyOnFrame']>[0]

  it('对照：无 stopReason 的 chat:done → 成功 toast + 声音（通知链健康）', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnFrame(chatFrame({ type: 'chat:done' }))
    await waitFor(() => {
      expect(playSuccessSound).toHaveBeenCalledTimes(1)
    })
    expect(document.querySelector('.toast-item .toast-message')?.textContent ?? '').toContain(
      '正文',
    )
  })

  it('chat:done + stopReason=superseded → 通知链零触发（AC-R3-6）', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnFrame(chatFrame({ type: 'chat:done', stopReason: 'superseded' }))
    await flushBroadcast()
    expect(playSuccessSound).not.toHaveBeenCalled()
    expect(playErrorSound).not.toHaveBeenCalled()
    expect(document.querySelector('.toast-item')).toBeNull()
  })

  it('chat:error + superseded → 失败通知链零触发', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnFrame(chatFrame({ type: 'chat:error', stopReason: 'superseded' }))
    await flushBroadcast()
    expect(playErrorSound).not.toHaveBeenCalled()
    expect(document.querySelector('.toast-item')).toBeNull()
  })

  it('非 superseded 来源（user）不误伤——照常通知', async () => {
    const { result } = renderNotifier()
    result.current.notifyOnFrame(chatFrame({ type: 'chat:done', stopReason: 'user' }))
    await waitFor(() => {
      expect(playSuccessSound).toHaveBeenCalledTimes(1)
    })
  })
})
