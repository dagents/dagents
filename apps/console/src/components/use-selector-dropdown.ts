'use client'

/**
 * useSelectorDropdown — 选择器族共享行为基座（PX-GL08 收口）。
 *
 * agent-selector / flow-selector / directory-selector 三者此前各自复制
 * 同一套：开合状态 + 外点关闭 + WAI-ARIA listbox 键盘导航 + 打开时聚焦
 * 触发器 + 稳定 listbox id。此 hook 承载行为；选项数据与选中语义留在
 * 各选择器（agent 的 CLI 快建、directory 的 OS 目录选择器互不相干）。
 *
 * 键位（焦点始终在触发器上，listbox 模式）：
 *   未开：↓/↑/Enter/Space 打开
 *   已开：↓/↑ 环绕移动高亮 · Home/End 跳首尾 · Enter 选中 · Esc/Tab 关闭
 *
 * 高亮只在「打开时」播种到当前选中项（flow-selector 的既有语义：打开后
 * 值再变不抢焦点/不重置高亮）；打开期间由 mouseenter 与按键驱动。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'

export interface useSelectorDropdownOptions {
  /** 可键盘导航的选项总数（数据加载后变化）。 */
  optionCount: number
  /** 打开时高亮播种到哪一项（通常是当前选中项的索引）。 */
  initialHighlight?: number
  /** Enter 选中高亮项。 */
  onSelectIndex: (idx: number) => void
}

export interface useSelectorDropdownResult {
  open: boolean
  setOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  toggle: () => void
  highlighted: number
  setHighlighted: React.Dispatch<React.SetStateAction<number>>
  /** 挂在选择器根 div。 */
  ref: React.RefObject<HTMLDivElement | null>
  /** 挂在触发器 button。 */
  triggerRef: React.RefObject<HTMLButtonElement | null>
  listboxId: string
  /** 挂在触发器 onKeyDown。 */
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void
}

export function useSelectorDropdown({
  optionCount,
  initialHighlight = 0,
  onSelectIndex,
}: useSelectorDropdownOptions): useSelectorDropdownResult {
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()

  // 外点关闭（mousedown 在浮层内不关）
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 打开：播种高亮 + 聚焦触发器（仅 open 变化时）
  useEffect(() => {
    if (!open) {
      setHighlighted(-1)
      return
    }
    setHighlighted(initialHighlight >= 0 && initialHighlight < optionCount ? initialHighlight : 0)
    triggerRef.current?.focus()
    // initialHighlight 由调用方从 props/数据派生，播种语义只在开合沿生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = useCallback(() => setOpen((v) => !v), [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen(true)
        }
        return
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setHighlighted((prev) => (optionCount === 0 ? 0 : (prev + 1) % optionCount))
          break
        case 'ArrowUp':
          e.preventDefault()
          setHighlighted((prev) => (optionCount === 0 ? 0 : (prev - 1 + optionCount) % optionCount))
          break
        case 'Home':
          e.preventDefault()
          setHighlighted(0)
          break
        case 'End':
          e.preventDefault()
          setHighlighted(Math.max(0, optionCount - 1))
          break
        case 'Enter':
          e.preventDefault()
          if (highlighted >= 0) onSelectIndex(highlighted)
          break
        case 'Escape':
          e.preventDefault()
          setOpen(false)
          break
        case 'Tab':
          setOpen(false)
          break
      }
    },
    [open, optionCount, highlighted, onSelectIndex],
  )

  return { open, setOpen, toggle, highlighted, setHighlighted, ref, triggerRef, listboxId, onKeyDown }
}
