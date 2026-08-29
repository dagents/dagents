'use client'

/**
 * DirectorySelector — project directory picker for the chat composer.
 *
 * Two ways to pick a directory:
 *   1. Select an already-registered directory from the dropdown.
 *   2. "浏览本地目录…" → calls the gateway, which spawns the OS-native
 *      directory picker (osascript on macOS, zenity on Linux, PowerShell
 *      on Windows) and returns the real absolute path. The browser itself
 *      cannot read absolute paths (web security boundary), but the gateway
 *      is a local process on the user's machine, so it has full FS access.
 *
 * The returned path is POSTed to /api/directories to register a new
 * directory record, then auto-selected. No manual path entry needed.
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'
import { createDirectory, pickDirectory } from '@/lib/directories'
import { useDirectories } from './use-directories'
import { useI18n } from '@/i18n'
import '@/styles/directory-selector.css'

interface DirectorySelectorProps {
  value: string | null
  onChange: (dirId: string) => void
}

export function DirectorySelector({
  value,
  onChange,
}: DirectorySelectorProps): React.ReactElement {
  const { t } = useI18n()
  const { directories, reload } = useDirectories()
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleBrowse = async (): Promise<void> => {
    setPickerError(null)
    setPicking(true)
    try {
      const path = await pickDirectory()
      if (!path) {
        // User cancelled the OS dialog — silent.
        return
      }
      // Register the picked path as a new directory. Backend derives a
      // default name from the leaf folder if `name` is omitted.
      const dir = await createDirectory({ path })
      await reload()
      onChange(dir.id)
      setOpen(false)
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  const selected = directories.find((d) => d.id === value)

  // 父组件 value 未落位（自己的目录 fetch 未完成）时回传默认 —— 否则
  // 「选择器已显示默认目录但发送仍报『请先选择项目目录』」的竞态对
  // 手快的真实用户同样成立（FAB 打开即发）。
  useEffect(() => {
    if (directories.length === 0 || value != null) return
    onChange(directories[0]!.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directories, value])

  return (
    <div className="directory-selector" ref={ref}>
      <button
        type="button"
        className="directory-selector-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="folder" style={{ width: 14, height: 14 }} />
        <span>{selected?.name ?? t('选择目录')}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="directory-selector-dropdown">
          <button
            type="button"
            className="directory-selector-browse"
            onClick={() => void handleBrowse()}
            disabled={picking}
          >
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>{picking ? t('等待选择…') : t('浏览本地目录…')}</span>
          </button>
          {directories.length === 0 && !picking ? (
            <div className="directory-selector-empty">{t('还没有项目目录，点击上方按钮添加')}</div>
          ) : null}
          {directories.length > 0 ? (
            <div className="directory-selector-list">
              {directories.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`directory-selector-option${value === d.id ? ' selected' : ''}`}
                  onClick={() => {
                    onChange(d.id)
                    setOpen(false)
                  }}
                >
                  <Icon name="folder" style={{ width: 14, height: 14 }} />
                  <span>{d.name}</span>
                  <span className="directory-selector-option-path">{d.path}</span>
                </button>
              ))}
            </div>
          ) : null}
          {pickerError ? (
            <div className="directory-selector-error">{pickerError}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}
