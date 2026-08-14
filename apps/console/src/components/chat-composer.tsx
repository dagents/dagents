'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import { Icon } from '@/components/icon'
import { AgentSelector } from '@/components/agent-selector'
import { FlowSelector } from '@/components/flow-selector'
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
  /** Currently bound flow id (null = none). */
  flowId?: string | null
  /** Called when user changes flow selection. */
  onFlowChange?: (flowId: string | null) => void
  /** Autofocus the textarea on mount (default true on chat home/detail). */
  autoFocus?: boolean
}

/** @-command definitions for the mention menu. */
interface CmdDef {
  trigger: string
  label: string
  hint: string
  icon: 'flows' | 'daemons' | 'agents'
  desc: string
}

const COMMANDS: readonly CmdDef[] = [
  { trigger: '@agent', label: '@agent', hint: '指定 Agent 执行', icon: 'agents', desc: '覆盖当前默认 Agent，用指定 Agent 执行任务' },
  { trigger: '@flow', label: '@flow', hint: '触发工作流', icon: 'flows', desc: '运行一个 AgentFlow 工作流，支持多步骤 DAG 编排' },
  { trigger: '@workflow', label: '@workflow', hint: 'AI 创建工作流', icon: 'flows', desc: '用自然语言描述需求，AI 自动生成工作流画布' },
  { trigger: '@daemon', label: '@daemon', hint: '发送 Daemon 命令', icon: 'daemons', desc: '向 Daemon 发送原始命令（如 shell 指令）' },
] as const

export function ChatComposer({
  onSend,
  onStop,
  stopping = false,
  disabled,
  placeholder = '发送消息…（输入 @ 触发命令）',
  agentSelector = true,
  agentId = null,
  onAgentChange,
  flowId = null,
  onFlowChange,
  autoFocus = false,
}: ChatComposerProps): React.ReactElement {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showCmdMenu, setShowCmdMenu] = useState(false)
  const [cmdIdx, setCmdIdx] = useState(0)
  const [cmdFilter, setCmdFilter] = useState('')

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

  // Detect @ at the start of input or after a space → show command menu
  const checkCmdTrigger = useCallback((text: string, cursorPos: number) => {
    // Find the word boundary before cursor
    const beforeCursor = text.slice(0, cursorPos)
    const atMatch = beforeCursor.match(/(?:^|\s)@([a-z]*)$/i)
    if (atMatch) {
      setCmdFilter(atMatch[1].toLowerCase())
      setShowCmdMenu(true)
      setCmdIdx(0)
    } else {
      setShowCmdMenu(false)
    }
  }, [])

  const filteredCmds = COMMANDS.filter((c) =>
    c.trigger.toLowerCase().includes(`@${cmdFilter}`),
  )

  const insertCommand = useCallback((cmd: CmdDef) => {
    const el = textareaRef.current
    if (!el) return
    const cursorPos = el.selectionStart ?? input.length
    const beforeCursor = input.slice(0, cursorPos)
    const afterCursor = input.slice(cursorPos)
    // Replace the partial @text with the full command + space
    const replaced = beforeCursor.replace(/(?:^|\s)@([a-z]*)$/i, ` ${cmd.trigger} `)
    const newVal = (replaced + afterCursor).replace(/^\s+/, '')
    setInput(newVal)
    setShowCmdMenu(false)
    // Focus and place cursor right after the command
    requestAnimationFrame(() => {
      const newCursor = cmd.trigger.length + 1
      el.focus()
      el.setSelectionRange(newCursor, newCursor)
    })
  }, [input])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setInput('')
    setShowCmdMenu(false)
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }, [input, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition guard
      if (e.nativeEvent.isComposing || e.keyCode === 229) return

      // Command menu navigation
      if (showCmdMenu && filteredCmds.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCmdIdx((p) => (p + 1) % filteredCmds.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCmdIdx((p) => (p - 1 + filteredCmds.length) % filteredCmds.length)
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter')) {
          e.preventDefault()
          insertCommand(filteredCmds[cmdIdx]!)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCmdMenu(false)
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, showCmdMenu, filteredCmds, cmdIdx, insertCommand],
  )

  const canSend = input.trim().length > 0 && !disabled
  const showStop = Boolean(onStop && stopping)

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer-card">
        {/* @ Command Menu */}
        {showCmdMenu && filteredCmds.length > 0 && (
          <div className="cmd-menu" role="listbox" aria-label="命令选择">
            {filteredCmds.map((cmd, i) => (
              <button
                key={cmd.trigger}
                type="button"
                role="option"
                aria-selected={i === cmdIdx}
                className={`cmd-menu-item${i === cmdIdx ? ' active' : ''}`}
                onMouseEnter={() => setCmdIdx(i)}
                onClick={() => insertCommand(cmd)}
              >
                <div className="cmd-menu-icon">
                  <Icon name={cmd.icon} style={{ width: 14, height: 14 }} />
                </div>
                <div className="cmd-menu-body">
                  <div className="cmd-menu-label">
                    <strong>{cmd.label}</strong>
                    <span className="cmd-menu-hint">{cmd.hint}</span>
                  </div>
                  <div className="cmd-menu-desc">{cmd.desc}</div>
                </div>
              </button>
            ))}
            <div className="cmd-menu-footer">
              <kbd>↑↓</kbd> 选择 · <kbd>Tab</kbd> 确认 · <kbd>Esc</kbd> 关闭
            </div>
          </div>
        )}

        <div className="chat-composer-top">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              checkCmdTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
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
          {onFlowChange && (
            <FlowSelector value={flowId} onChange={onFlowChange} disabled={disabled} />
          )}
          <span className="chat-composer-hint">
            {'⏎'} 发送 · {'⇧⏎'} 换行 · {'@'} 命令
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
