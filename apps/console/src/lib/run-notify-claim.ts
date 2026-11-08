/**
 * run-notify-claim —— 跨标签页 run 完成通知 claim（R9b「至多一次」的最后
 * 一公里，design-sharp §2.2 console 侧第 3 条）。
 *
 * BroadcastChannel('dagents:run-notify') 上 per-runId 首个 claim 者发通知、
 * 其余标签页静默。claim 消息竞态的兜底：Notification `tag`（调用方沿用
 * 'dagents-task-done'）保证 OS 层同 run 至多一条可见。刷新/单标签页场景
 * BroadcastChannel 无对手，claim 恒成功——行为与单发一致。
 *
 * 广播范围只进同源页面（BroadcastChannel 语义）——非安全面，纯去重面。
 */

const CHANNEL_NAME = 'dagents:run-notify'

interface ClaimChannel {
  /** 尝试 claim：成功（本页首发）返回 true，他人已 claim 返回 false。 */
  claim(runId: string): boolean
  close(): void
}

/** 测试注入缝（jsdom 无 BroadcastChannel 时由测试 stub）。 */
export function createRunNotifyClaimChannel(): ClaimChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  const channel = new BroadcastChannel(CHANNEL_NAME)
  const claimedByOthers = new Set<string>()
  channel.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { type?: string; runId?: string }
    if (data?.type === 'claim' && typeof data.runId === 'string') {
      claimedByOthers.add(data.runId)
    }
  }
  return {
    claim(runId: string): boolean {
      if (claimedByOthers.has(runId)) return false
      claimedByOthers.add(runId) // 自己也算已占（重复调用幂等）
      try {
        channel.postMessage({ type: 'claim', runId })
      } catch {
        // 广播失败不阻断本页通知（单标签页场景无对手）
      }
      return true
    },
    close(): void {
      channel.close()
    },
  }
}

/**
 * 单例 accessor：页面级一个 channel（多 hook 共享）；不可用时返回 null =
 * 无跨页对手，调用方视为 claim 恒成功（单标签页行为）。
 */
let shared: ClaimChannel | null | undefined

export function sharedRunNotifyClaim(): ClaimChannel | null {
  if (shared === undefined) shared = createRunNotifyClaimChannel()
  return shared
}

/** 测试钩子：重置单例。 */
export function resetRunNotifyClaimForTests(): void {
  if (shared) shared.close()
  shared = undefined
}
