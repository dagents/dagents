'use client'

/**
 * Chat Home (/) — Chat-First landing page.
 *
 * Layout (design-redo paradigm):
 *   - Centered placeholder: bot avatar + welcome + 2×2 suggestion cards
 *   - Bottom: unified composer (agent selector + @ hints + send)
 *
 * No sidebar here — the sidebar is global (ChatNavSidebar in ChatLayout).
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icon'
import { SuggestionCards } from '@/components/suggestion-cards'
import { OnboardingChecklist } from '@/components/onboarding-checklist'
import { OnboardingCompleteBanner } from '@/components/onboarding-complete-banner'
import { useOnboarding } from '@/components/use-onboarding'
import { ChatComposer } from '@/components/chat-composer'
import { DirectorySelector } from '@/components/directory-selector'
import { useDirectories } from './use-directories'
import { createChat, createMessage } from '@/lib/chats'
import { pickDirectory, createDirectory } from '@/lib/directories'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import '@/styles/chat-home.css'

export function ChatHome(): React.ReactElement {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const { directories, loading, error, reload } = useDirectories()
  const { complete: onboardingComplete } = useOnboarding()
  const [selectedDirId, setSelectedDirId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [addingDir, setAddingDir] = useState(false)

  useEffect(() => {
    if (directories.length > 0 && !selectedDirId) setSelectedDirId(directories[0]!.id)
  }, [directories, selectedDirId])

  // Directory-list load failures surface as a transient toast (the inline
  // bottom-of-page div used to be invisible next to the big welcome block).
  useEffect(() => {
    if (error) toast.error(t('项目目录加载失败'), 6000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  /** Returns false to keep the composer draft (send rejected / failed). */
  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (sending) return false
    const directoryId = selectedDirId ?? directories[0]?.id
    if (!directoryId) {
      toast.warning(t('请先添加项目目录'))
      return false
    }
    setSending(true)
    try {
      const chat = await createChat({
        directoryId,
        title: text.slice(0, 50),
        ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
      })
      await createMessage(chat.id, { content: text, role: 'user' })
      router.push(`/chats/${chat.id}`)
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setSending(false)
      return false
    }
  }, [sending, selectedDirId, directories, selectedAgentId, router, t, toast])

  const handleAddDirectory = useCallback(async (): Promise<void> => {
    setAddingDir(true)
    try {
      const path = await pickDirectory()
      if (!path) return // user cancelled the OS dialog
      const dir = await createDirectory({ path })
      // Set selection BEFORE reload so the empty state hides immediately,
      // even if reload() fails (reload swallows errors internally).
      setSelectedDirId(dir.id)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAddingDir(false)
    }
  }, [reload, toast])

  return (
    <div className="chat-home-body">
      <div className="chat-home-topbar">
        <DirectorySelector value={selectedDirId} onChange={setSelectedDirId} />
      </div>
      {loading && directories.length === 0 ? (
        /* First-paint skeleton — don't flash the welcome copy before the
         * directory probe resolves (it decides empty-state vs welcome). */
        <div className="chat-home-placeholder">
          <div className="chat-home-placeholder-inner" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)', minHeight: 180 }}>
            <div className="skeleton" style={{ width: 48, height: 48, borderRadius: '50%' }} />
            <div className="skeleton-text" style={{ width: 160, height: 18 }} />
            <div className="skeleton-text" style={{ width: 260, height: 12 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', width: '100%', maxWidth: 560, marginTop: 'var(--space-2)' }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skeleton" style={{ height: 64, borderRadius: 'var(--radius-md)' }} />
              ))}
            </div>
          </div>
        </div>
      ) : directories.length === 0 && !selectedDirId ? (
        <div className="chat-home-empty">
          <div className="chat-home-empty-icon">
            <Icon name="folder" style={{ width: 48, height: 48, color: 'var(--accent)' }} />
          </div>
          <h2 className="chat-home-empty-title">{t('开始前，请先添加一个项目目录')}</h2>
          <p className="chat-home-empty-desc">
            {t('DAgent 需要知道在哪里运行 Agent。添加一个本地目录即可开始对话。')}
          </p>
          <button
            type="button"
            className="chat-home-empty-cta"
            onClick={() => void handleAddDirectory()}
            disabled={addingDir}
          >
            <Icon name="plus" style={{ width: 14, height: 14 }} />
            <span>{addingDir ? t('等待选择…') : t('浏览本地目录…')}</span>
          </button>
          <div className="chat-home-empty-steps">
            <div className="chat-home-empty-step">
              <div className="chat-home-empty-step-num">1</div>
              <span className="chat-home-empty-step-text">{t('添加项目目录')}</span>
            </div>
            <div className="chat-home-empty-step">
              <div className="chat-home-empty-step-num">2</div>
              <span className="chat-home-empty-step-text">{t('创建 Agent')}</span>
            </div>
            <div className="chat-home-empty-step">
              <div className="chat-home-empty-step-num">3</div>
              <span className="chat-home-empty-step-text">{t('开始对话')}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-home-placeholder">
          <div className="chat-home-placeholder-inner">
            <div className="chat-home-bot-avatar">
              <Icon name="bot" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
            </div>
            <h1 className="chat-home-welcome-title">{t('开始对话')}</h1>
            <p className="chat-home-welcome-desc">
              {t('选择项目目录，输入指令，Agent 会理解你的意图并执行。')}
            </p>
            <OnboardingChecklist />
            <OnboardingCompleteBanner complete={onboardingComplete} />
            <SuggestionCards disabled={sending} onPick={(text) => void handleSend(text)} />
          </div>
        </div>
      )}

      {/* Composer */}
      <ChatComposer
        onSend={handleSend}
        disabled={sending || (directories.length === 0 && !selectedDirId)}
        agentId={selectedAgentId}
        onAgentChange={setSelectedAgentId}
        autoFocus
      />
    </div>
  )
}
