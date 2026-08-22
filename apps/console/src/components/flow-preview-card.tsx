'use client'

/**
 * FlowPreviewCard — @workflow 生成成功的结构化预览卡。
 *
 * gateway 的 routeWorkflowCommand（chat-execute.ts）成功时用 persistComplete
 * 写一条 markdown 消息（`✅ 工作流已创建… 👉 [打开画布编辑](/workflows/{id}/canvas)`）。
 * persistComplete 的 metadata 只装 runId/status/usage/durationMs/cost，不支持
 * 附加自定义字段（需 gateway 配合才能走 metadata 路线），所以 console 侧解析
 * 消息 markdown 识别成功态 —— 消息格式由自家 gateway 代码生成，解析是稳定的。
 *
 * 组件挂在 AssistantContent 里（chat-detail 与 floating-chat 共用的渲染链），
 * 命中即渲染卡片替代纯文本；未命中（普通回复 / 生成失败 / 流式中）原样渲染。
 */

import Link from 'next/link'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import '@/styles/flow-preview-card.css'

/** 解析结果 — 字段全部可选于消息之外，但 flowId 必有（来自画布链接）。 */
export interface WorkflowSuccessInfo {
  flowId: string
  flowName: string | null
  nodeCount: number | null
  /** 引擎名（cli / http / agent:xxx / cli-then-http）。 */
  engine: string | null
  /** 自动修复轮数（`（自动修复 N 轮后通过）` 后缀），未出现为 null。 */
  repairRounds: number | null
  /** 消息里的 ⚠️ 警告行（被丢弃节点 / 生成警告），原文照录。 */
  warnings: string[]
}

/** 成功标记行（routeWorkflowCommand 固定输出，作为识别的必要条件之一）。 */
const SUCCESS_MARKER = /✅\s*工作流已创建/
/** 画布链接 — flowId 是卡片两个 CTA 的锚点，也是识别的必要条件。 */
const CANVAS_LINK = /\[打开画布编辑\]\(\/workflows\/([^)\s]+)\/canvas\)/
const NAME_LINE = /\*\*名称\*\*:\s*(.+)/
const NODES_LINE = /\*\*节点数\*\*:\s*(\d+)/
/** 引擎行可带 `（自动修复 N 轮后通过）` 后缀，拆开后分别展示（m：按行锚定）。 */
const ENGINE_LINE =
  /\*\*引擎\*\*:\s*([^\n]+?)(?:（自动修复\s*(\d+)\s*轮后通过）)?\s*$/m
/** ⚠️ 开头的警告行（被丢弃节点提示 + 生成警告，每行一条）。 */
const WARNING_LINE = /^⚠️\s*(.+)$/gm

/**
 * 识别 @workflow 生成成功消息并抽取卡片字段。返回 null 表示不是该类消息
 * （普通回复、失败消息、半截流式内容都不命中 —— 必须同时有成功标记与画布链接）。
 * 纯函数，可单测。
 */
export function parseWorkflowSuccessMessage(content: string): WorkflowSuccessInfo | null {
  if (!content) return null
  if (!SUCCESS_MARKER.test(content)) return null
  const link = content.match(CANVAS_LINK)
  if (!link) return null

  const name = content.match(NAME_LINE)?.[1]?.trim() ?? null
  const nodeCount = Number(content.match(NODES_LINE)?.[1] ?? Number.NaN)
  const engineMatch = content.match(ENGINE_LINE)

  const warnings: string[] = []
  for (const m of content.matchAll(WARNING_LINE)) {
    warnings.push(m[1].trim())
  }

  return {
    flowId: link[1],
    flowName: name && name.length > 0 ? name : null,
    nodeCount: Number.isFinite(nodeCount) ? nodeCount : null,
    engine: engineMatch?.[1]?.trim() || null,
    repairRounds: engineMatch?.[2] != null ? Number(engineMatch[2]) : null,
    warnings,
  }
}

export interface FlowPreviewCardProps {
  info: WorkflowSuccessInfo
}

/** 成功预览卡 — 名称 / 节点数 / 引擎 + 「打开画布」「去 Flows 运行」。 */
export function FlowPreviewCard({ info }: FlowPreviewCardProps): React.ReactElement {
  const { t } = useI18n()

  const metaParts: string[] = []
  // 复用 flows 模块既有的 '{n} 节点' 词条（词典全局合并，不重复维护）。
  if (info.nodeCount != null) metaParts.push(t('{n} 节点', { n: info.nodeCount }))
  if (info.engine) metaParts.push(t('引擎 {engine}', { engine: info.engine }))

  return (
    <div className="flow-preview-card">
      <div className="flow-preview-card-header">
        <Icon name="flows" style={{ width: 15, height: 15 }} />
        <span className="flow-preview-card-title">{t('工作流已创建')}</span>
        {info.repairRounds != null && info.repairRounds > 0 ? (
          <span className="flow-preview-card-repair">
            {t('自动修复 {n} 轮后通过', { n: info.repairRounds })}
          </span>
        ) : null}
      </div>

      <div className="flow-preview-card-name" title={info.flowName ?? undefined}>
        {info.flowName ?? t('AI 生成的工作流')}
      </div>

      {metaParts.length > 0 ? (
        <div className="flow-preview-card-meta">{metaParts.join(' · ')}</div>
      ) : null}

      {/* 生成警告（被丢弃节点等）原文透传 —— 信息不丢，但视觉降为次要。 */}
      {info.warnings.length > 0 ? (
        <ul className="flow-preview-card-warnings">
          {info.warnings.map((w, i) => (
            <li key={i}>
              <Icon name="alertTriangle" style={{ width: 12, height: 12 }} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flow-preview-card-actions">
        <Link
          href={`/workflows/${info.flowId}/canvas`}
          className="flow-preview-card-btn flow-preview-card-btn-primary"
        >
          <Icon name="pencil" style={{ width: 12, height: 12 }} />
          <span>{t('打开画布')}</span>
        </Link>
        <Link href="/flows" className="flow-preview-card-btn">
          <Icon name="zap" style={{ width: 12, height: 12 }} />
          <span>{t('去 Flows 运行')}</span>
        </Link>
      </div>
    </div>
  )
}
