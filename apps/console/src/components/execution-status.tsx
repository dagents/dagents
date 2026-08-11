'use client'

/**
 * ExecutionStatusIndicator — global task status light in the navbar.
 *
 * Polls /api/fleet-stats every 10s to get the current fleet state.
 * Shows:
 *   🔘 gray dot    = idle (no running tasks)
 *   🟢 pulse dot   = N tasks running (click → /daemons)
 *   🔴 red dot     = has failed tasks (click → /daemons)
 *
 * Mounted in the navbar (chat-layout.tsx), visible on all pages.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useDesktopNotification } from '@/lib/use-desktop-notification'
import '@/styles/status-indicator.css'

interface FleetData {
  active: number
  queued: number
  failed: number
}

const POLL_MS = 10_000

export function ExecutionStatusIndicator(): React.ReactElement {
  const [data, setData] = useState<FleetData>({ active: 0, queued: 0, failed: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      try {
        const res = await fetch('/api/fleet-stats')
        if (res.ok) {
          const json = await res.json()
          const stats = json?.data ?? json
          if (!cancelled) {
            setData({
              active: stats?.active_tasks ?? 0,
              queued: stats?.queue_depth ?? 0,
              failed: 0,
            })
            setLoading(false)
          }
        }
      } catch {
        // Silent — keep last known state
      }
      if (!cancelled) {
        timer = setTimeout(poll, POLL_MS)
      }
    }

    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const hasRunning = data.active > 0
  const hasFailed = data.failed > 0

  // Fire desktop notification when a task completes while the page is hidden
  useDesktopNotification({ activeCount: data.active, hasFailed })

  let cls = 'idle'
  let label = '空闲'
  if (hasFailed) {
    cls = 'failed'
    label = `${data.failed} 个失败`
  } else if (hasRunning) {
    cls = 'running'
    label = `${data.active} 个运行中`
  } else if (data.queued > 0) {
    cls = 'queued'
    label = `${data.queued} 个排队`
  }

  return (
    <Link
      href="/daemons"
      className={`exec-status ${cls}`}
      title={loading ? '加载中…' : `任务状态：${label}`}
      aria-label={`执行状态：${label}`}
    >
      <span className="exec-status-dot" />
      {!loading && (hasRunning || data.queued > 0) && (
        <span className="exec-status-label">{label}</span>
      )}
    </Link>
  )
}
