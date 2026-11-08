/**
 * useWsRun — subscribe to run-updated frames for a specific runId（R9b，
 * design-sharp §2.2 console 侧；对称 use-ws-chat.ts 的 chat 维度）。
 *
 * 挂载即按 runId 订阅（refcount 合并），run-updated 帧转发给 onFrame；
 * 卸载/runId 变更退订。重连安全由 ws-client 的 onopen re-arm 承载。
 */
'use client'

import { useEffect } from 'react'
import { useWsFrame, subscribeRun, unsubscribeRun } from './ws-client'
import type { ConsoleWsFrame } from '@dagents/contracts'

export interface RunUpdatedFrame {
  type: 'run-updated'
  runId: string
  status: string
  flowId?: string
  stopReason?: string
}

/**
 * Subscribe to run-updated frames for `runId`. Pass `null` to skip
 * subscription — the hook becomes inert.
 */
export function useWsRun(
  runId: string | null,
  onFrame: (frame: RunUpdatedFrame) => void,
): { connected: boolean } {
  const handle = (frame: ConsoleWsFrame) => {
    if (frame.type !== 'run-updated') return
    if (runId == null) return
    if (frame.runId !== runId) return
    onFrame(frame)
  }

  const { connected } = useWsFrame(handle)

  useEffect(() => {
    if (runId == null) return
    subscribeRun(runId)
    return () => {
      unsubscribeRun(runId)
    }
  }, [runId])

  return { connected }
}
