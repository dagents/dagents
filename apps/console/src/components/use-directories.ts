'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDirectories, type Directory } from '@/lib/directories'

export interface UseDirectoriesResult {
  directories: Directory[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useDirectories(): UseDirectoriesResult {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    // Abort any in-flight reload so the most recent call wins.
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const dirs = await fetchDirectories(ctrl.signal)
      if (!ctrl.signal.aborted) setDirectories(dirs)
    } catch (err) {
      // Ignore AbortError — expected when a newer reload supersedes this one.
      if (ctrl.signal.aborted) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    return () => ctrlRef.current?.abort()
  }, [reload])

  return { directories, loading, error, reload }
}
