'use client'

/**
 * Onboarding Checklist — compact inline setup guide.
 *
 * In the inline-executor architecture, there is NO daemon step — the
 * gateway spawns CLI directly. Only 3 steps matter:
 *   1. ✅ 项目目录已添加  → GET /api/directories returns ≥1
 *   2. ✅ CLI 已安装      → GET /api/cli-runtimes returns ≥1 available
 *   3. ✅ Agent 已创建    → GET /api/agents returns ≥1
 *
 * Renders as a slim horizontal progress bar (not a big card) so it never
 * pushes the composer out of the viewport. Auto-hides when all done.
 */
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/onboarding.css'

interface StepState {
  id: string
  label: string
  done: boolean
  href?: string
}

const DISMISS_KEY = 'dagents:onboarding-dismissed'

export function OnboardingChecklist(): React.ReactElement | null {
  const { t } = useI18n()
  const [steps, setSteps] = useState<StepState[]>([
    { id: 'dir', label: '项目目录', done: false, href: '/' },
    { id: 'cli', label: 'CLI 已安装', done: false, href: '/settings' },
    { id: 'agent', label: 'Agent 已创建', done: false, href: '/agents' },
  ])
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const [dirsRes, cliRes, agentsRes] = await Promise.all([
          fetch('/api/directories'),
          fetch('/api/cli-runtimes'),
          fetch('/api/agents'),
        ])

        const dirs = dirsRes.ok ? await dirsRes.json() : null
        const cli = cliRes.ok ? await cliRes.json() : null
        const agents = agentsRes.ok ? await agentsRes.json() : null

        const dirList = dirs?.data?.items ?? dirs?.items ?? (Array.isArray(dirs) ? dirs : [])
        const runtimes = cli?.data?.runtimes ?? cli?.runtimes ?? []
        const hasCli = Array.isArray(runtimes) && runtimes.some((r: { available: boolean }) => r.available)
        const agentList = agents?.data?.agents ?? agents?.agents ?? (Array.isArray(agents) ? agents : [])

        if (!cancelled) {
          setSteps([
            { id: 'dir', label: '项目目录', done: dirList.length > 0, href: '/' },
            { id: 'cli', label: 'CLI 已安装', done: hasCli, href: '/settings' },
            { id: 'agent', label: 'Agent 已创建', done: agentList.length > 0, href: '/agents' },
          ])
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    void check()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === 'true')
  }, [])

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, 'true')
    setDismissed(true)
  }, [])

  if (loading || dismissed) return null

  const doneCount = steps.filter((s) => s.done).length
  const allDone = doneCount === steps.length

  if (allDone) return null

  return (
    <div className="onboarding-inline">
      <div className="onboarding-inline-bar">
        <span className="onboarding-inline-title">{t('🚀 快速配置')}</span>
        <div className="onboarding-inline-steps">
          {steps.map((step) => (
            <span key={step.id} className={`onboarding-inline-chip${step.done ? ' done' : ''}`}>
              {step.done ? (
                <Icon name="check" style={{ width: 10, height: 10 }} />
              ) : (
                <span className="onboarding-inline-dot" />
              )}
              {step.done ? (
                <span className="onboarding-inline-label">{t(step.label)}</span>
              ) : step.href ? (
                <Link href={step.href} className="onboarding-inline-label link">{t(step.label)} →</Link>
              ) : (
                <span className="onboarding-inline-label">{t(step.label)}</span>
              )}
            </span>
          ))}
        </div>
        <span className="onboarding-inline-count">{doneCount}/{steps.length}</span>
        <button type="button" className="onboarding-inline-dismiss" onClick={handleDismiss} aria-label={t('关闭')}>×</button>
      </div>
    </div>
  )
}
