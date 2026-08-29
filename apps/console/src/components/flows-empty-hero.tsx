'use client'

/**
 * FlowsEmptyHero — Workflow-First 首页空态（PRD F1）。
 *
 * 新用户第一屏的转化入口：三入口（团队场景模板 / 一句话生成 / 空白画布）
 * + 内置模板横滑卡。旧空态只有一个「新建 Flow」按钮，撑不起主场。
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

  return (
    <div className="flows-hero">
      <div className="flows-hero-head">
        <h1 className="flows-hero-title">{t('把你的 Agent 团队编成一条流程')}</h1>
        <p className="flows-hero-sub">
          {t('本地 CLI 执行 · 多 Agent 并行 · 运行可旁观')}
        </p>
      </div>

      <div className="flows-hero-entries">
        <button type="button" className="flows-hero-entry primary" onClick={onTemplate}>
          <Icon name="dashboard" style={{ width: 18, height: 18 }} />
          <span className="flows-hero-entry-title">{t('从团队场景开始')}</span>
          <span className="flows-hero-entry-desc">{t('内置多 Agent 模板，一键启用')}</span>
        </button>
        <button type="button" className="flows-hero-entry" onClick={onGenerate}>
          <Icon name="zap" style={{ width: 18, height: 18 }} />
          <span className="flows-hero-entry-title">{t('一句话生成')}</span>
          <span className="flows-hero-entry-desc">{t('描述目标，自动编排画布')}</span>
        </button>
        <button type="button" className="flows-hero-entry" onClick={onCreate}>
          <Icon name="plus" style={{ width: 18, height: 18 }} />
          <span className="flows-hero-entry-title">{t('空白画布')}</span>
          <span className="flows-hero-entry-desc">{t('从零搭建节点与连线')}</span>
        </button>
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
