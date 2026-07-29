'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import { Icon } from '@/components/icon'
import { AgentSelector } from '@/components/agent-selector'
import '@/styles/chat-composer.css'

interface ChatComposerProps {
  onSend: (text: string) => void
  /** When true the send button is replaced by a stop button that calls onStop. */
  onStop?: () => void
  /** True while a request is in-flight; swaps send → stop when onStop is set. */
  stopping?: boolean
  disabled?: boolean
  placeholder?: string
  agentSelector?: boolean
  /** Currently selected agent (null = auto). */
  agentId?: string | null
  /** Called when user changes agent selection. */
  onAgentChange?: (agentId: string | null) => void
  /** Autofocus the textarea on mount (default true on chat home/detail). */
  autoFocus?: boolean
}

export function ChatComposer({
  onSend,
  onStop,
  stopping = false,
  disabled,
  placeholder = '发送消息…',
  agentSelector = true,
  agentId = null,
  onAgentChange,
  autoFocus = false,
}: ChatComposerProps): React.ReactElement {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus on mount (and when chatId changes on detail — the parent remounts).
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  // Auto-resize: grow with content up to max-height, collapse when emptied.
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  useEffect(() => {
    resize()
  }, [input, resize])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setInput('')
    // Reset height after send (the input effect will fire, but reset the
    // textarea immediately so the collapse is visible before the next paint).
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }, [input, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition guard: when a CJK IME is composing (e.g. the user is
      // mid-pinyin and presses Enter to confirm the composition), `isComposing`
      // is true and Enter must NOT send — it confirms the IME composition
      // instead. The legacy `keyCode === 229` fallback covers older browsers.
      // Without this guard, Chinese/Japanese/Korean users would send a
      // half-composed message every time they confirmed an IME candidate.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const canSend = input.trim().length > 0 && !disabled
  // Show the stop button only when an in-flight run can be cancelled.
  const showStop = Boolean(onStop && stopping)

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer-card">
        <div className="chat-composer-top">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="chat-composer-textarea"
            rows={1}
            disabled={disabled}
            aria-label="消息输入框"
          />
        </div>
        <div className="chat-composer-bottom">
          {agentSelector && onAgentChange && (
            <AgentSelector value={agentId} onChange={onAgentChange} disabled={disabled} />
          )}
          <span className="chat-composer-hint">
            ⏎ 发送 · ⇧⏎ 换行
          </span>
          {showStop ? (
            <button
              type="button"
              className="chat-composer-stop"
              onClick={onStop}
              title="停止生成"
              aria-label="停止生成"
            >
              <Icon name="stop" style={{ width: 14, height: 14 }} />
            </button>
          ) : (
            <button
              type="button"
              className="chat-composer-send"
              onClick={handleSend}
              disabled={!canSend}
              title="发送消息"
              aria-label="发送消息"
            >
              <Icon name="send" style={{ width: 16, height: 16 }} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
