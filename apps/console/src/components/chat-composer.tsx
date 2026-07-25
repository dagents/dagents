'use client'

import { useRef, useState, useCallback } from 'react'
import { Icon } from '@/components/icon'
import { AgentSelector } from '@/components/agent-selector'
import '@/styles/chat-composer.css'

interface ChatComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  placeholder?: string
  agentSelector?: boolean
  /** Currently selected agent (null = auto). */
  agentId?: string | null
  /** Called when user changes agent selection. */
  onAgentChange?: (agentId: string | null) => void
}

export function ChatComposer({
  onSend,
  disabled,
  placeholder = 'Send a message…',
  agentSelector = true,
  agentId = null,
  onAgentChange,
}: ChatComposerProps): React.ReactElement {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setInput('')
  }, [input, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const canSend = input.trim().length > 0 && !disabled

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer-card">
        <div className="chat-composer-top">
          <button type="button" className="chat-composer-attach" title="Attach file">
            <Icon name="plus" style={{ width: 18, height: 18 }} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="chat-composer-textarea"
            rows={1}
            disabled={disabled}
          />
        </div>
        <div className="chat-composer-bottom">
          {agentSelector && onAgentChange && (
            <AgentSelector value={agentId} onChange={onAgentChange} disabled={disabled} />
          )}
          <span className="chat-composer-hint">
            ⏎ 发送 · ⇧⏎ 换行 · 输入 @ 触发命令
          </span>
          <button
            type="button"
            className="chat-composer-send"
            onClick={handleSend}
            disabled={!canSend}
            title="Send message"
          >
            <Icon name="send" style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>
    </div>
  )
}
