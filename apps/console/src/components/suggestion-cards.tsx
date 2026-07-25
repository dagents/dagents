'use client'

import Link from 'next/link'
import { Icon, type IconName } from '@/components/icon'
import '@/styles/suggestion-cards.css'

interface SuggestionCardsProps {
  /** When a card has `href`, it navigates instead of calling onPick. */
  onPick?: (text: string) => void
}

interface Suggestion {
  icon: IconName
  text: string
  /** When set, the card links to this href instead of triggering onPick. */
  href?: string
}

const SUGGESTIONS: readonly Suggestion[] = [
  { icon: 'zap', text: '帮我创建一个批量推理的 AgentFlow', href: '/flows' },
  { icon: 'agents', text: '查看当前资源看板的 agent 状态', href: '/agents' },
  { icon: 'flows', text: '设计一个多步骤的 Workspace 任务' },
  { icon: 'lab', text: '测试新的 Agent prompt 模板' },
] as const

export function SuggestionCards({ onPick }: SuggestionCardsProps): React.ReactElement {
  return (
    <div className="suggestion-grid">
      {SUGGESTIONS.map((s) => {
        const inner = (
          <>
            <div className="suggestion-card-icon">
              <Icon name={s.icon} style={{ width: 14, height: 14 }} />
            </div>
            <span className="suggestion-card-text">{s.text}</span>
          </>
        )
        if (s.href) {
          return (
            <Link key={s.text} href={s.href} className="suggestion-card">
              {inner}
            </Link>
          )
        }
        return (
          <button
            key={s.text}
            type="button"
            className="suggestion-card"
            onClick={() => onPick?.(s.text)}
          >
            {inner}
          </button>
        )
      })}
    </div>
  )
}
