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

import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import { createDirectory, pickDirectory } from '@/lib/directories'
import { useDirectories } from './use-directories'
import { useSelectorDropdown } from '@/components/use-selector-dropdown'
import { useI18n } from '@/i18n'
import '@/styles/selector.css'
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
  const [picking, setPicking] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)

  // 共享行为基座（PX-GL08）：开合/外点/键盘 listbox 导航/聚焦 —— 此前
  // 此选择器完全没有键盘可达性，现在与 agent/flow 同语义。目录列表是
  // 纯平铺（无「auto」占位项），高亮直接对应目录索引。
  const {
    open, setOpen, highlighted, setHighlighted,
    ref, triggerRef, listboxId, onKeyDown,
  } = useSelectorDropdown({
    optionCount: directories.length,
    initialHighlight: value === null ? 0 : Math.max(0, directories.findIndex((d) => d.id === value)),
    onSelectIndex: (idx) => {
      const d = directories[idx]
      if (d) {
        onChange(d.id)
        setOpen(false)
      }
    },
  })

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
        ref={triggerRef}
        type="button"
        className="directory-selector-trigger"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={t('选择目录')}
      >
        <Icon name="folder" style={{ width: 14, height: 14 }} />
        <span>{selected?.name ?? t('选择目录')}</span>
        <Icon name="chevronDown" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('选择目录')}
          className="directory-selector-dropdown"
          aria-activedescendant={highlighted >= 0 ? `${listboxId}-opt-${highlighted}` : undefined}
        >
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
              {directories.map((d, i) => (
                <button
                  key={d.id}
                  id={`${listboxId}-opt-${i}`}
                  type="button"
                  role="option"
                  aria-selected={value === d.id}
                  className={`directory-selector-option${value === d.id ? ' selected' : ''}${highlighted === i ? ' highlighted' : ''}`}
                  onClick={() => {
                    onChange(d.id)
                    setOpen(false)
                  }}
                  onMouseEnter={() => setHighlighted(i)}
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
