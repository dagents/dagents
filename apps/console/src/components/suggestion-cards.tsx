'use client'

import { Icon, type IconName } from '@/components/icon'
import '@/styles/suggestion-cards.css'

interface SuggestionCardsProps {
  onPick?: (text: string) => void
}

interface Suggestion {
  icon: IconName
  text: string
}

const SUGGESTIONS: readonly Suggestion[] = [
  { icon: 'zap', text: '帮我创建一个批量推理的 AgentFlow' },
  { icon: 'agents', text: '查看当前资源看板的 agent 状态' },
  { icon: 'flows', text: '设计一个多步骤的 Workspace 任务' },
  { icon: 'lab', text: '测试新的 Agent prompt 模板' },
] as const

export function SuggestionCards({ onPick }: SuggestionCardsProps): React.ReactElement {
  return (
    <div className="suggestion-grid">
      {SUGGESTIONS.map((s) => (
        <button
          key={s.text}
          type="button"
          className="suggestion-card"
          onClick={() => onPick?.(s.text)}
        >
          <div className="suggestion-card-icon">
            <Icon name={s.icon} style={{ width: 14, height: 14 }} />
          </div>
          <span className="suggestion-card-text">{s.text}</span>
        </button>
      ))}
    </div>
  )
}

