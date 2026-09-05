'use client'

/**
 * HoverCard — anchored hover preview card (deepseek-harness ui-primitives
 * HoverCard, lightweight port). Wraps an anchor element (ref + mouse
 * handlers injected via cloneElement), shows a fixed-position dark card
 * through a body portal after a delay; moving onto the card keeps it open
 * (grace window bridges the anchor→card gap), so interactive content
 * (copy buttons) is reachable.
 */

import { Children, useCallback, cloneElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import '@/styles/hover-card.css'

interface HoverCardProps {
  /** Card content; rendered inside `.hover-card` in a body portal. */
  content: ReactNode
  /** Anchor element — must accept a ref and mouse handlers (a plain
   *  wrapper div is the expected shape). */
  children: ReactNode
  /** Hover delay before the card appears (ms). PX-GL05 default 150ms —
   *  足以滤掉快速划过（不再闪卡），又不至于感觉迟钝。 */
  delayMs?: number
  /** Suppress the card (row is being renamed, menu open, …). */
  disabled?: boolean
}

const CARD_WIDTH = 280

export function HoverCard({ content, children, delayMs = 150, disabled }: HoverCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const anchorRef = useRef<HTMLElement | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  // True while the pointer is inside the card (checked by the anchor-leave
  // grace timer before dismissing).
  const onCardRef = useRef(false)

  const clearTimer = () => window.clearTimeout(timerRef.current)

  const enter = useCallback(() => {
    if (disabled) return
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // Right of the anchor (the sidebar hugs the left edge); clamp into
      // the viewport so long titles never spill.
      const left = Math.min(r.right + 8, window.innerWidth - CARD_WIDTH - 8)
      const top = Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - 180))
      setPos({ left, top })
      setOpen(true)
    }, delayMs)
  }, [delayMs, disabled])

  const leave = useCallback(() => {
    clearTimer()
    // Grace: moving from the anchor onto the card cancels the dismiss.
    timerRef.current = window.setTimeout(() => {
      if (!onCardRef.current) setOpen(false)
    }, 140)
  }, [])

  // Disabled while open → close immediately (rename started, menu opened).
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => clearTimer, [])

  const child = Children.only(children) as React.ReactElement<{
    ref?: unknown
    onMouseEnter?: (e: unknown) => void
    onMouseLeave?: (e: unknown) => void
  }>
  const anchored = cloneElement(child, {
    ref: (node: HTMLElement | null) => { anchorRef.current = node },
    onMouseEnter: (e: unknown) => { child.props.onMouseEnter?.(e); enter() },
    onMouseLeave: (e: unknown) => { child.props.onMouseLeave?.(e); leave() },
  })

  if (typeof document === 'undefined') return anchored

  return (
    <>
      {anchored}
      {open
        ? createPortal(
            <div
              ref={cardRef}
              className="hover-card"
              style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }}
              onMouseEnter={() => { onCardRef.current = true; clearTimer() }}
              onMouseLeave={() => { onCardRef.current = false; setOpen(false) }}
              role="tooltip"
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
