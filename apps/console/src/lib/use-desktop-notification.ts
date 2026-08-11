'use client'

/**
 * useDesktopNotification — notify the user when a long-running task completes.
 *
 * Uses the Web Notifications API. When a transition from active→idle or
 * active→failed is detected, fires a desktop notification (if permission
 * was granted) so the user knows their task finished even if they tabbed away.
 *
 * The hook tracks `document.visibilityState === 'hidden'` so notifications
 * only fire when the page is NOT visible (don't spam when already looking).
 */

import { useEffect, useRef } from 'react'

interface NotifyOptions {
  /** Current number of active tasks (0 = idle). */
  activeCount: number
  /** Whether any tasks have failed. */
  hasFailed: boolean
  /** Title for the notification. */
  title?: string
}

export function useDesktopNotification({ activeCount, hasFailed, title = 'Dagents' }: NotifyOptions) {
  const prevActive = useRef(activeCount)
  const prevFailed = useRef(hasFailed)

  // Request permission on first user interaction (not on mount — that's annoying)
  useEffect(() => {
    const onClick = () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }
      window.removeEventListener('click', onClick)
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [])

  useEffect(() => {
    const wasActive = prevActive.current > 0
    const nowIdle = activeCount === 0
    const newFailure = !prevFailed.current && hasFailed
    const isHidden = document.visibilityState === 'hidden'

    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return

    // Task completed: active→idle transition
    if (wasActive && nowIdle && isHidden) {
      new Notification(title, {
        body: newFailure ? '任务执行失败，请查看详情' : '任务已完成',
        icon: '/favicon.ico',
        tag: 'dagents-task-done',
      })
    }

    prevActive.current = activeCount
    prevFailed.current = hasFailed
  }, [activeCount, hasFailed, title])
}
