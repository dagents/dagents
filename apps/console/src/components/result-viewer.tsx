'use client'

/**
 * ResultViewer —— 运行结果的「查看全文」出口（2026-09-06 设计师裁决）。
 *
 * 结果面板里的输出块被 max-height 小滚动框困住（面板本身就在画布头部，
 * 空间局促，嵌套滚动看不全长输出）。每个输出块右上角给一个展开入口，
 * 点开全屏查看器：完整正文（不截断）+ 复制 + Esc/点背景关闭。
 *
 * 摘要视图（正文/输入/原始数据/产出 JSON）与终端视图（成品正文/事件详情）
 * 共用；块内仍显示原来的截断/滚动形态，全屏才是保真出口。
 */

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/icon'
import { useI18n } from '@/i18n'
import './result-viewer.css'

/** 包一层输出块：悬浮露出 maximize 角标，点开全屏查看器。 */
export function ResultViewer({
  title,
  text,
  mono = false,
  children,
}: {
  /** 查看器标题（节点名 / 节点名 · 输入 等）。 */
  title: string
  /** 全屏展示的完整文本（调用方负责给未截断版本）。 */
  text: string
  /** JSON/mono 载荷用等宽字体渲染。 */
  mono?: boolean
  /** 块内原样渲染的内容（保留截断/滚动形态）。 */
  children: ReactNode
}): React.ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <div className='rv-wrap'>
      {children}
      <button
        type='button'
        className='rv-open'
        title={t('查看全文')}
        aria-label={t('查看全文：{title}', { title })}
        onClick={() => setOpen(true)}
      >
        <Icon name='maximize' style={{ width: 12, height: 12 }} />
      </button>
      {open ? (
        <FullTextModal title={title} text={text} mono={mono} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  )
}

/** 全屏文本查看器：portal 到 body，Esc / 点背景关闭，头部复制。 */
function FullTextModal({
  title,
  text,
  mono,
  onClose,
}: {
  title: string
  text: string
  mono: boolean
  onClose(): void
}): React.ReactElement {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return createPortal(
    <div className='rv-overlay' role='dialog' aria-modal='true' aria-label={title} onClick={onClose}>
      <div
        className='rv-modal'
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <div className='rv-head'>
          <span className='rv-title' title={title}>{title}</span>
          <button type='button' className='rv-copy' onClick={copy}>
            {copied ? t('已复制') : t('复制')}
          </button>
          <button type='button' className='rv-close' aria-label={t('关闭')} onClick={onClose}>
            ×
          </button>
        </div>
        <pre className={`rv-body${mono ? ' mono' : ''}`}>{text}</pre>
      </div>
    </div>,
    document.body,
  )
}
