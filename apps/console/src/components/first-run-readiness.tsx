'use client'

/**
 * FirstRunReadiness — 首次运行环境自检横幅（2026-09-18 PM 优化）。
 *
 * 新用户第一大死路：「零配置基线」的前提是本机装了 CLI 或配了 Provider ——
 * 两者皆无时，LLM/Agent 节点会在运行时才失败，用户在画布上得到的是一堵墙。
 * 本横幅在入口页提前把事实摆出来：检测 /api/cli-runtimes 与 /api/llm-providers，
 * 两者皆无 → 黄条警告 + 「去设置」直达；任一就绪 → 不渲染（沉默即健康）。
 * 「不再提示」持久化 localStorage（版本化键，未来检测维度变化可重置）。
 */
import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'

const DISMISS_KEY = 'dagents.readiness.dismissed.v1'

interface CliRuntimeLike {
  kind?: string
  installed?: boolean
}

export function FirstRunReadiness(): React.ReactElement | null {
  const { t } = useI18n()
  const [warn, setWarn] = useState(false)

  useEffect(() => {
    let cancelled = false
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') return
    } catch { /* 私隐模式等场景忽略 */ }
    void (async () => {
      try {
        const [cliRes, provRes] = await Promise.all([
          fetch('/api/cli-runtimes').then((r) => r.json()).catch(() => null),
          fetch('/api/llm-providers').then((r) => r.json()).catch(() => null),
        ])
        if (cancelled) return
        const hasCli = Boolean(
          cliRes?.success &&
          Array.isArray(cliRes.data?.runtimes) &&
          cliRes.data.runtimes.some((r: CliRuntimeLike) => r.installed),
        )
        const hasProvider = Boolean(
          provRes?.success &&
          Array.isArray(provRes.data) &&
          provRes.data.length > 0,
        )
        setWarn(!hasCli && !hasProvider)
      } catch {
        // 检测失败不打扰 —— 宁可漏报不误报
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!warn) return null

  const dismiss = (): void => {
    setWarn(false)
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch { /* 忽略 */ }
  }

  return (
    <div className="readiness-banner" role="status">
      <Icon name="zap" />
      <span className="readiness-banner-text">
        {t('未检测到任何 CLI 运行时，也未配置 LLM Provider —— LLM/Agent 节点将无法运行')}
      </span>
      <a className="readiness-banner-link" href="/settings">{t('去设置')}</a>
      <button type="button" className="readiness-banner-dismiss" onClick={dismiss}>
        {t('不再提示')}
      </button>
    </div>
  )
}
