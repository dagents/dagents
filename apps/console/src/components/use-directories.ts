'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchDirectories, type Directory } from '@/lib/directories'

export interface UseDirectoriesResult {
  directories: Directory[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

// 模块级 in-flight promise 缓存：多个组件 mount 时复用同一个请求，
// 避免 React 18 StrictMode 双触发导致的 AbortController 误杀
// （StrictMode 在 dev 下先 mount → cleanup abort → 再 mount，
//  第一次的 fetch 被 abort 产生 ERR_ABORTED 红错）。
let inflight: Promise<Directory[]> | null = null

async function loadDirectories(): Promise<Directory[]> {
  if (!inflight) {
    inflight = fetchDirectories().finally(() => { inflight = null })
  }
  return inflight
}

export function useDirectories(): UseDirectoriesResult {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const dirs = await loadDirectories()
      setDirectories(dirs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { directories, loading, error, reload }
}
