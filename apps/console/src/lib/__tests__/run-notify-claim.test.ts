/**
 * run-notify-claim 单测（R9b「至多一次」最后一公里，design-sharp §2.2
 * console 侧第 3 条 / §6.5）。
 *
 * 如实标注：设计文档预判「jsdom 无 BroadcastChannel」在本环境不成立——
 * vitest 的 jsdom 环境透传 Node ≥18 的全局 BroadcastChannel。缺席分支
 * （旧浏览器/沙箱兜底 = 单标签页语义）经显式摘除全局验证；跨标签页行为
 * 经最小 stub 验证——两个互连实例模拟两个标签页，postMessage 异步投递
 * （microtask，对齐真实 BroadcastChannel 的投递语义）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createRunNotifyClaimChannel,
  sharedRunNotifyClaim,
  resetRunNotifyClaimForTests,
} from '@/lib/run-notify-claim'

/** 最小 BroadcastChannel stub：同名实例互连，postMessage 异步投递到对端。 */
class FakeBroadcastChannel {
  static readonly registry = new Map<string, Set<FakeBroadcastChannel>>()
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(readonly name: string) {
    const set = FakeBroadcastChannel.registry.get(name) ?? new Set()
    set.add(this)
    FakeBroadcastChannel.registry.set(name, set)
  }
  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.registry.get(this.name) ?? new Set()
    for (const peer of peers) {
      if (peer === this) continue
      queueMicrotask(() => peer.onmessage?.({ data }))
    }
  }
  close(): void {
    FakeBroadcastChannel.registry.get(this.name)?.delete(this)
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('run-notify-claim（跨标签页 claim）', () => {
  beforeEach(() => {
    resetRunNotifyClaimForTests()
    FakeBroadcastChannel.registry.clear()
  })
  afterEach(() => {
    resetRunNotifyClaimForTests()
    FakeBroadcastChannel.registry.clear()
    // @ts-expect-error 测试注入的临时全局，卸下（真全局由注入用例自行保存恢复）
    delete globalThis.BroadcastChannel
  })

  it('BroadcastChannel 缺席（显式摘除全局模拟旧浏览器）→ sharedRunNotifyClaim 返回 null = 单标签页语义，调用方视为 claim 恒成功', () => {
    const saved = globalThis.BroadcastChannel
    // @ts-expect-error 测试期摘除
    delete globalThis.BroadcastChannel
    try {
      expect(globalThis.BroadcastChannel).toBeUndefined()
      expect(sharedRunNotifyClaim()).toBeNull()
    } finally {
      if (saved) globalThis.BroadcastChannel = saved
    }
  })

  it('首个 claim 成功、重复 claim 幂等 false、不同 runId 互不影响', () => {
    // @ts-expect-error 注入 stub
    globalThis.BroadcastChannel = FakeBroadcastChannel
    const claim = createRunNotifyClaimChannel()
    expect(claim).not.toBeNull()
    expect(claim!.claim('run-1')).toBe(true)
    expect(claim!.claim('run-1')).toBe(false) // 自身重复 → 幂等
    expect(claim!.claim('run-2')).toBe(true)
    claim!.close()
  })

  it('跨标签页：标签页 A claim 后，标签页 B 对同 runId claim 失败（异步投递后）', async () => {
    // @ts-expect-error 注入 stub
    globalThis.BroadcastChannel = FakeBroadcastChannel
    const tabA = createRunNotifyClaimChannel()
    const tabB = createRunNotifyClaimChannel()
    expect(tabA!.claim('run-x')).toBe(true)
    // 消息异步到达 B —— flush 后 B 的 claimedByOthers 含 run-x
    await flushMicrotasks()
    expect(tabB!.claim('run-x')).toBe(false)
    expect(tabB!.claim('run-y')).toBe(true)
    tabA!.close()
    tabB!.close()
  })

  it('单例 accessor：sharedRunNotifyClaim 复用同一实例；reset 关闭并重建', () => {
    // @ts-expect-error 注入 stub
    globalThis.BroadcastChannel = FakeBroadcastChannel
    const a = sharedRunNotifyClaim()
    const b = sharedRunNotifyClaim()
    expect(a).toBe(b)
    resetRunNotifyClaimForTests()
    const c = sharedRunNotifyClaim()
    expect(c).not.toBe(a)
  })
})
