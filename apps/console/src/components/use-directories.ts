'use client'

import { useEffect, useState } from 'react'
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

  const reload = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const dirs = await fetchDirectories()
      setDirectories(dirs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return { directories, loading, error, reload }
}
