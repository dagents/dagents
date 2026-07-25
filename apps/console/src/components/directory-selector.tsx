'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import { fetchDirectories, type Directory } from '@/lib/directories'
import '@/styles/directory-selector.css'

interface DirectorySelectorProps {
  value: string | null
  onChange: (dirId: string) => void
}

export function DirectorySelector({ value, onChange }: DirectorySelectorProps): React.ReactElement {
  const [directories, setDirectories] = useState<Directory[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dirs = await fetchDirectories()
        if (!cancelled) setDirectories(dirs)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selected = directories.find((d) => d.id === value)

  return (
    <div className="directory-selector" ref={ref}>
      <button
        type="button"
        className="directory-selector-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="folder" style={{ width: 14, height: 14 }} />
        <span>{selected?.name ?? '选择目录'}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="directory-selector-dropdown">
          {directories.length === 0 ? (
            <a className="directory-selector-empty" href="/directories">
              添加项目目录 →
            </a>
          ) : (
            directories.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`directory-selector-option${value === d.id ? ' selected' : ''}`}
                onClick={() => { onChange(d.id); setOpen(false) }}
              >
                <Icon name="folder" style={{ width: 14, height: 14 }} />
                <span>{d.name}</span>
                <span className="directory-selector-option-path">{d.path}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
