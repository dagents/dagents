'use client'

import { useEffect, useState } from 'react'
import type { Chat, ChatRun } from '@/lib/chats'
import { fetchChatRuns, updateChat } from '@/lib/chats'
import type { Directory } from '@/lib/directories'
import { AgentSelector } from '@/components/agent-selector'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/chat-context-panel.css'

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  failed: '失败',
}

interface ChatContextPanelProps {
  chat: Chat | null
  directory: Directory | null
}

export function ChatContextPanel({ chat, directory }: ChatContextPanelProps): React.ReactElement {
  const { t } = useI18n()
  const [runs, setRuns] = useState<ChatRun[]>([])
  const [editingAgent, setEditingAgent] = useState(false)
  const [editingFlow, setEditingFlow] = useState(false)
  const [flowInput, setFlowInput] = useState('')

  useEffect(() => {
    if (!chat) return
    let cancelled = false
    void (async () => {
      try {
        const r = await fetchChatRuns(chat.id)
        if (!cancelled) setRuns(r)
      } catch {
        // best-effort run-history load; a fetch failure here must not surface
      }
    })()
    return () => { cancelled = true }
  }, [chat?.id, chat?.updatedAt])

  const handleAgentChange = async (agentId: string | null) => {
    if (!chat) return
    try {
      await updateChat(chat.id, { agentId })
      // Caller (chat-detail) should refresh chat — emit a custom event
      window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId: chat.id } }))
    } catch (err) {
      console.warn('agent update failed', err)
    }
    setEditingAgent(false)
  }

  const handleFlowSave = async () => {
    if (!chat) return
    try {
      await updateChat(chat.id, { flowId: flowInput || null })
      window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId: chat.id } }))
    } catch (err) {
      console.warn('flow update failed', err)
    }
    setEditingFlow(false)
  }

  return (
    <div className="chat-context-panel">
      {/* Directory */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">{t('所属目录')}</div>
        {directory ? (
          <div className="chat-context-item" title={directory.path}>
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span className="chat-context-dir-name">{directory.name}</span>
            {directory.path ? (
              <span className="chat-context-dir-path">{directory.path}</span>
            ) : null}
          </div>
        ) : (
          <div className="muted">—</div>
        )}
      </div>

      {/* Agent — editable */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">
          {t('绑定 Agent')}
          {!editingAgent && (
            <button className="chat-context-edit" onClick={() => setEditingAgent(true)}>{t('编辑')}</button>
          )}
        </div>
        {editingAgent ? (
          <AgentSelector value={chat?.agentId ?? null} onChange={handleAgentChange} />
        ) : (
          <div className="chat-context-item" title={chat?.agentId ?? t('自动选择')}>
            <Icon name="bot" style={{ width: 14, height: 14, flexShrink: 0 }} />
            <span className="chat-context-mono-truncate">
              {chat?.agentId ? chat.agentId.slice(0, 8) : 'auto'}
            </span>
          </div>
        )}
      </div>

      {/* Flow — editable */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">
          {t('绑定 Flow')}
          {!editingFlow && (
            <button className="chat-context-edit" onClick={() => { setFlowInput(chat?.flowId ?? ''); setEditingFlow(true) }}>{t('编辑')}</button>
          )}
        </div>
        {editingFlow ? (
          <div className="chat-context-flow-edit">
            <input
              type="text"
              value={flowInput}
              onChange={(e) => setFlowInput(e.target.value)}
              placeholder="Flow ID"
              className="chat-context-flow-input"
            />
            <button className="chat-context-flow-save" onClick={handleFlowSave}>{t('保存')}</button>
            <button className="chat-context-flow-cancel" onClick={() => setEditingFlow(false)}>{t('取消')}</button>
          </div>
        ) : (
          <div className="chat-context-item" title={chat?.flowId ?? t('未绑定')}>
            <Icon name="flows" style={{ width: 14, height: 14, flexShrink: 0 }} />
            <span className="chat-context-mono-truncate">
              {chat?.flowId ? chat.flowId.slice(0, 8) : '—'}
            </span>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">{t('统计')}</div>
        <div className="chat-context-stats">
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">{t('消息数')}</span>
            <span className="chat-context-stat-value">{chat?.messageCount ?? 0}</span>
          </div>
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">{t('状态')}</span>
            <span className={`chat-context-stat-value status-${chat?.status ?? 'idle'}`}>
              {t(STATUS_LABEL[chat?.status ?? 'idle'] ?? chat?.status ?? '空闲')}
            </span>
          </div>
        </div>
      </div>

      {/* Real runs */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">{t('执行记录')}</div>
        {runs.length === 0 ? (
          <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>{t('暂无执行记录')}</div>
        ) : (
          <div className="chat-context-runs">
            {runs.slice(0, 10).map((r) => (
              <div key={r.id} className="chat-context-run">
                <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
                  {r.id.slice(0, 8)}
                </span>
                <span className={`chat-context-run-status status-${r.status}`}>{t(STATUS_LABEL[r.status] ?? r.status)}</span>
                {chat?.flowId ? (
                  <a
                    href={`/workflows/${chat.flowId}/canvas?run=${r.id}`}
                    style={{ fontSize: 'var(--text-xs)', flexShrink: 0 }}
                    title={t('在画布中查看此运行的节点级进度')}
                  >
                    {t('画布查看')}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
