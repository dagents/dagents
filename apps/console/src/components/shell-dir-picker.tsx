'use client'

/**
 * ShellDirPicker — 终端页的新会话目录选择器（紧凑版 directory-selector）。
 *
 * 纯展示 + 下拉交互：主目录默认项 + 已注册项目目录 +「浏览本地目录…」。
 * 键盘可达性走共享基座 useSelectorDropdown；决策语义（显式意图异目录换仓/
 * 同目录不打扰）的单一事实源在 lib/shell-session-plan，本组件只发起意图。
 */

import { Icon } from '@/components/icon'
import { useSelectorDropdown } from '@/components/use-selector-dropdown'
import { useI18n } from '@/i18n'

export interface ShellDirPickerDirectory {
  id: string
  name: string
  path: string
}

export interface ShellDirPickerProps {
  /** 当前目录偏好（null = 主目录）。 */
  dirId: string | null
  directories: ShellDirPickerDirectory[]
  /** 选定目录（或 null 回主目录）—— 由宿主执行换仓语义。 */
  onPick: (dirId: string | null) => void
  /** 「浏览本地目录…」（OS 原生选框 → 注册新目录 → 切换）。 */
  onBrowse: () => void
  picking: boolean
}

export function ShellDirPicker({ dirId, directories, onPick, onBrowse, picking }: ShellDirPickerProps): React.ReactElement {
  const { t } = useI18n()
  const selectedDir = directories.find((d) => d.id === dirId)

  // 键盘可达的下拉（共享基座）：0 = 主目录，1..n = 已注册目录
  const {
    open,
    setOpen,
    highlighted,
    setHighlighted,
    ref: pickerRef,
    triggerRef,
    listboxId,
    onKeyDown,
  } = useSelectorDropdown({
    optionCount: directories.length + 1,
    initialHighlight: dirId === null ? 0 : Math.max(0, directories.findIndex((d) => d.id === dirId) + 1),
    onSelectIndex: (idx) => {
      onPick(idx === 0 ? null : directories[idx - 1]?.id ?? null)
      setOpen(false)
    },
  })

  return (
    <div className="term-dir" ref={pickerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost term-btn term-dir-trigger"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={t('新会话的工作目录')}
      >
        <Icon name="folder" className="ic-14" />
        <span>{selectedDir ? selectedDir.name : t('主目录')}</span>
        <Icon name="chevronDown" className="ic-12" />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('新会话的工作目录')}
          className="term-dir-dropdown"
          aria-activedescendant={highlighted >= 0 ? `${listboxId}-opt-${highlighted}` : undefined}
        >
          <button
            type="button"
            id={`${listboxId}-opt-0`}
            role="option"
            aria-selected={dirId === null}
            className={`term-dir-option${dirId === null ? ' selected' : ''}${highlighted === 0 ? ' highlighted' : ''}`}
            onClick={() => {
              onPick(null)
              setOpen(false)
            }}
            onMouseEnter={() => setHighlighted(0)}
          >
            <Icon name="folder" className="ic-14" />
            <span>{t('主目录')}</span>
          </button>
          {directories.map((d, i) => (
            <button
              key={d.id}
              type="button"
              id={`${listboxId}-opt-${i + 1}`}
              role="option"
              aria-selected={dirId === d.id}
              className={`term-dir-option${dirId === d.id ? ' selected' : ''}${highlighted === i + 1 ? ' highlighted' : ''}`}
              onClick={() => {
                onPick(d.id)
                setOpen(false)
              }}
              onMouseEnter={() => setHighlighted(i + 1)}
            >
              <Icon name="folder" className="ic-14" />
              <span>{d.name}</span>
              <span className="term-dir-option-path">{d.path}</span>
            </button>
          ))}
          <button
            type="button"
            className="term-dir-browse"
            onClick={onBrowse}
            disabled={picking}
          >
            <Icon name="plus" className="ic-14" />
            <span>{picking ? t('等待选择…') : t('浏览本地目录…')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
