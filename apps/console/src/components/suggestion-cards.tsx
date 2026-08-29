'use client'

import { useEffect, useState } from 'react'
import { Icon, type IconName } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/suggestion-cards.css'

interface SuggestionCardsProps {
  onPick?: (text: string) => void
  /** Disable all cards (e.g. while a send is in-flight) — prevents
   *  double-click creating two chats. */
  disabled?: boolean
}

interface Suggestion {
  icon: IconName
  /** i18n key — rendered via t(text, params). */
  text: string
  /** Optional interpolation params for keys like 查看 Agent「{name}」…. */
  params?: Record<string, string>
}

/** Starter suggestions for users who finished onboarding but haven't started
 *  a chat yet — actionable prompts that lean on directory context. */
const ONBOARDING_DONE_SUGGESTIONS: readonly Suggestion[] = [
  { icon: 'brain', text: '帮我理解这个项目的架构' },
  { icon: 'lab', text: '写一个单元测试' },
  { icon: 'refresh', text: '审查最近的代码变更' },
  { icon: 'pencil', text: '帮我重构一个函数' },
] as const

/** Onboarding suggestions for first-time users with no resources yet. */
const ONBOARDING_SUGGESTIONS: readonly Suggestion[] = [
  { icon: 'folder', text: '如何添加我的第一个项目目录？' },
  { icon: 'agents', text: '帮我创建第一个 Agent' },
  { icon: 'flows', text: '什么是 AgentFlow？' },
  { icon: 'lab', text: '这个平台能做什么？' },
] as const

/**
 * Default suggestions for returning users with existing resources.
 *
 * 2026-08-23 产品复盘（docs 会话记录）：旧四条全部失败——「资源看板」/
 * 「Workspace」是被砍掉的 v0.2 概念，「创建 AgentFlow」7 次点击 0 产出
 * （普通消息不触发生成管线，agent 甚至不认识 AgentFlow 一词）。新四条
 * 绑定真实能力：@workflow 前缀直通生成管线（注意 en 词条必须保留前缀，
 * onPick 发送的是翻译后文本），其余为已验证的目录场景真能力。
 */
const DEFAULT_SUGGESTIONS: readonly Suggestion[] = [
  { icon: 'zap', text: '@workflow 帮我生成一个代码审查工作流' },
  { icon: 'brain', text: '帮我理解这个项目的架构' },
  { icon: 'refresh', text: '审查最近的代码变更' },
  { icon: 'pencil', text: '这个项目有哪些可以改进的地方？' },
] as const

export function SuggestionCards({ onPick, disabled = false }: SuggestionCardsProps): React.ReactElement {
  const { t } = useI18n()
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>(DEFAULT_SUGGESTIONS)

  // Dynamically pick suggestions based on user's resource state.
  // Priority: onboarding-done-with-zero-chats → first-time (no resources) →
  // agent running → default. chat_count comes from the directories list
  // (gateway's normalizeDir sums chats per directory).
  useEffect(() => {
    let cancelled = false
    async function checkResources() {
      try {
        // Probe agents + directories + LLM providers + daemons so we can tell
        // "onboarding fully done" apart from "user has some resources".
        const [agentsRes, dirsRes, llmRes, daemonsRes] = await Promise.all([
          fetch('/api/agents'),
          fetch('/api/directories'),
          fetch('/api/llm-providers'),
          fetch('/api/daemons'),
        ])
        const agents = agentsRes.ok ? await agentsRes.json() : []
        const dirs = dirsRes.ok ? await dirsRes.json() : []
        const llms = llmRes.ok ? await llmRes.json() : []
        const daemons = daemonsRes.ok ? await daemonsRes.json() : []
        // Gateway wraps responses as { success, data: { ... } }
        // Agents: data.agents; Directories: data.items
        // LLM Providers: data.providers; Daemons: data.daemons
        const agentList = agents?.data?.agents ?? agents?.agents ?? (Array.isArray(agents) ? agents : [])
        const dirList = dirs?.data?.items ?? dirs?.items ?? (Array.isArray(dirs) ? dirs : [])
        const llmList = llms?.data?.providers ?? llms?.providers ?? (Array.isArray(llms) ? llms : [])
        const daemonList = daemons?.data?.daemons ?? daemons?.daemons ?? (Array.isArray(daemons) ? daemons : [])

        const hasOnlineDaemon = daemonList.some(
          (d: Record<string, unknown>) => d.status === 'online' || d.status === 'idle',
        )
        // Sum chats across directories to detect "zero chats".
        const chatCount = dirList.reduce(
          (sum: number, d: Record<string, unknown>) =>
            sum + Number(d.chatCount ?? d.chat_count ?? 0),
          0,
        )

        if (!cancelled) {
          if (agentList.length === 0 && dirList.length === 0) {
            setSuggestions(ONBOARDING_SUGGESTIONS)
          } else if (
            // Onboarding fully complete AND user has not started any chat →
            // show actionable starter suggestions with directory context.
            dirList.length > 0 &&
            llmList.length > 0 &&
            hasOnlineDaemon &&
            agentList.length > 0 &&
            chatCount === 0
          ) {
            setSuggestions(ONBOARDING_DONE_SUGGESTIONS)
          } else if (agentList.length > 0) {
            // User has agents — suggest context-aware actions
            const runningAgent = agentList.find((a: Record<string, unknown>) => a.status === 'running') as Record<string, unknown> | undefined
            const agentName = runningAgent ? String(runningAgent.name ?? runningAgent.id ?? 'Agent') : ''
            if (runningAgent) {
              setSuggestions([
                // Params live on the card so the label translates as one key
                // (previously the finished Chinese string could never hit the dict).
                { icon: 'agents', text: '查看 Agent「{name}」的运行状态', params: { name: agentName } },
                { icon: 'zap', text: '@workflow 帮我生成一个代码审查工作流' },
                { icon: 'brain', text: '帮我理解这个项目的架构' },
                { icon: 'refresh', text: '审查最近的代码变更' },
              ])
            } else {
              setSuggestions(DEFAULT_SUGGESTIONS)
            }
          }
        }
      } catch {
        // Silently fall back to defaults on error
        if (!cancelled) setSuggestions(DEFAULT_SUGGESTIONS)
      }
    }
    void checkResources()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="suggestion-grid">
      {suggestions.map((s, i) => (
        <button
          key={s.text}
          type="button"
          className="suggestion-card enter-rise"
          style={{ '--enter-i': i } as React.CSSProperties}
          disabled={disabled}
          onClick={() => onPick?.(t(s.text, s.params))}
        >
          <div className="suggestion-card-icon">
            <Icon name={s.icon} style={{ width: 14, height: 14 }} />
          </div>
          <span className="suggestion-card-text">{t(s.text, s.params)}</span>
        </button>
      ))}
    </div>
  )
}
