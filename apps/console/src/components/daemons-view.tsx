'use client'

import { useEffect, useState } from 'react'
import { DaemonsQueue, type DispatchTask } from '@/components/daemons-queue'
import { DaemonsTimeline } from '@/components/daemons-timeline'
import { DaemonsStats, type FleetStats } from '@/components/daemons-stats'
import { fetchDispatchTasks, fetchFleetStats } from '@/lib/daemons'
import '@/styles/daemons.css'

type Filter = 'all' | 'queued' | 'running' | 'done' | 'failed'

const FILTERS: ReadonlyArray<Filter> = ['all', 'queued', 'running', 'done', 'failed']

export function DaemonsView(): React.ReactElement {
  const [tasks, setTasks] = useState<DispatchTask[]>([])
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const status = filter === 'all' ? undefined : filter
        const [t, s] = await Promise.all([
          fetchDispatchTasks(status),
          fetchFleetStats().catch(() => null),
        ])
        if (cancelled) return
        setTasks(t)
        if (s) setStats(s)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const interval = setInterval(load, 5000) // refresh every 5s
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [filter])

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null

  return (
    <div className="daemons-view">
      <div className="daemons-toolbar">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`daemons-filter${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="daemons-grid">
        <DaemonsQueue
          tasks={tasks}
          loading={loading}
          selectedId={selectedTaskId}
          onSelect={setSelectedTaskId}
        />
        <DaemonsTimeline task={selectedTask} />
        <DaemonsStats stats={stats} tasks={tasks} />
      </div>
      {error && <div className="daemons-error">{error}</div>}
    </div>
  )
}
