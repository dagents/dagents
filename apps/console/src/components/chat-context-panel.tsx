'use client'

import type { Chat, ChatMessage } from '@/lib/chats'
import type { Directory } from '@/lib/directories'
import { Icon } from '@/components/icon'
import '@/styles/chat-context-panel.css'

interface ChatContextPanelProps {
  chat: Chat | null
  directory: Directory | null
  messages: ChatMessage[]
}

export function ChatContextPanel({ chat, directory, messages }: ChatContextPanelProps): React.ReactElement {
  return (
    <div className="chat-context-panel">
      {/* Directory */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">所属目录</div>
        {directory ? (
          <div className="chat-context-item">
            <Icon name="folder" style={{ width: 14, height: 14 }} />
            <span>{directory.name}</span>
          </div>
        ) : (
          <div className="muted">—</div>
        )}
      </div>

      {/* Agent */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">绑定 Agent</div>
        <div className="chat-context-item">
          <Icon name="bot" style={{ width: 14, height: 14 }} />
          <span>{chat?.agentId ?? 'auto'}</span>
        </div>
      </div>

      {/* Flow */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">绑定 Flow</div>
        <div className="chat-context-item">
          <Icon name="flows" style={{ width: 14, height: 14 }} />
          <span>{chat?.flowId ?? '—'}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">统计</div>
        <div className="chat-context-stats">
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">消息数</span>
            <span className="chat-context-stat-value">{chat?.messageCount ?? 0}</span>
          </div>
          <div className="chat-context-stat">
            <span className="chat-context-stat-label">状态</span>
            <span className={`chat-context-stat-value status-${chat?.status ?? 'idle'}`}>
              {chat?.status ?? 'idle'}
            </span>
          </div>
        </div>
      </div>

      {/* Recent runs (from messages with runId) */}
      <div className="chat-context-section">
        <div className="chat-context-section-title">执行记录</div>
        {messages.filter((m) => m.runId).length === 0 ? (
          <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>暂无执行记录</div>
        ) : (
          <div className="chat-context-runs">
            {messages
              .filter((m) => m.runId)
              .slice(-5)
              .map((m) => (
                <div key={m.id} className="chat-context-run">
                  <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--meta)' }}>
                    {m.runId?.slice(0, 8)}
                  </span>
                  <span className="chat-context-run-role">{m.role}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
