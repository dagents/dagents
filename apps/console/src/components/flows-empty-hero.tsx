'use client'

/**
 * FlowsEmptyHero — Workflow-First 首页空态（PRD F1；PX-F03 重设计）。
 *
 * 新用户第一屏的转化入口。旧版「对称三卡 + 彩底图标」是典型 AI 落地页
 * 姿势（feature-grid 黑名单款），改为纵向入口清单：每行 20px 图标槽 +
 * 标题 + 描述 + 右缘箭头，整组限宽 560px 居中；主入口（团队场景）用
 * accent-soft 微底，其余素卡；入场 stagger 38ms × 3。
 */
import { useEffect, useState } from 'react'
import { Icon } from '@/components/icon'
import { type FlowTemplateSummary, fetchFlowTemplates } from '@/lib/flow-templates'
import { useI18n } from '@/i18n'
import '@/styles/flows-empty-hero.css'

export interface FlowsEmptyHeroProps {
  onTemplate: () => void
  onGenerate: () => void
  onCreate: () => void
}

export function FlowsEmptyHero({
  onTemplate,
  onGenerate,
  onCreate,
}: FlowsEmptyHeroProps): React.ReactElement {
  const { t } = useI18n()
  const [templates, setTemplates] = useState<FlowTemplateSummary[]>([])

  // 内置模板横滑卡（失败静默 —— 三入口仍可用，卡片是增强）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await fetchFlowTemplates()
        if (!cancelled) setTemplates(list.slice(0, 8))
      } catch {
        // 静默降级
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const entries = [
    {
      key: 'template',
      icon: 'dashboard',
      title: t('从团队场景开始'),
      desc: t('内置多 Agent 模板，一键启用'),
      onClick: onTemplate,
      primary: true,
    },
    {
      key: 'generate',
      icon: 'zap',
      title: t('一句话生成'),
      desc: t('描述目标，自动编排画布'),
      onClick: onGenerate,
      primary: false,
    },
    {
      key: 'create',
      icon: 'plus',
      title: t('空白画布'),
      desc: t('从零搭建节点与连线'),
      onClick: onCreate,
      primary: false,
    },
  ] as const

  return (
    <div className="flows-hero">
      <div className="flows-hero-head">
        <h1 className="flows-hero-title">{t('把你的 Agent 团队编成一条流程')}</h1>
        <p className="flows-hero-sub">
          {t('本地 CLI 执行 · 多 Agent 并行 · 运行可旁观')}
        </p>
      </div>

      {/* 纵向入口清单（PX-F03）：行卡 --radius-md、组限宽 560px 居中、
          stagger 38ms × 3（.enter-rise 消费 --enter-i）。 */}
      <div className="flows-hero-entries" role="list">
        {entries.map((e, i) => (
          <button
            key={e.key}
            type="button"
            role="listitem"
            className={`flows-hero-entry enter-rise${e.primary ? ' primary' : ''}`}
            style={{ '--enter-i': i } as React.CSSProperties}
            onClick={e.onClick}
          >
            <span className="flows-hero-entry-icon" aria-hidden="true">
              <Icon name={e.icon} style={{ width: 18, height: 18 }} />
            </span>
            <span className="flows-hero-entry-text">
              <span className="flows-hero-entry-title">{e.title}</span>
              <span className="flows-hero-entry-desc">{e.desc}</span>
            </span>
            <span className="flows-hero-entry-arrow" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </span>
          </button>
        ))}
      </div>

      {templates.length > 0 ? (
        <div className="flows-hero-templates">
          <div className="flows-hero-templates-label">{t('内置模板')}</div>
          <div className="flows-hero-templates-strip" role="list">
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className="flows-hero-tpl-card"
                onClick={onTemplate}
                title={tpl.description || tpl.name}
                role="listitem"
              >
                <span className="flows-hero-tpl-name">{tpl.name}</span>
                {tpl.description ? (
                  <span className="flows-hero-tpl-desc">{tpl.description.slice(0, 40)}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
