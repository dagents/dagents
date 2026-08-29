'use client'

/**
 * WorkflowRunCard — 聊天里的「工作流执行卡」。
 *
 * 回答一个问题：这条回复到底用没用工作流、跑到哪了。三层信息密度：
 *   1. 收起态（默认）：⚡ 工作流 · 流程名 · 总耗时/tokens + 节点进度链
 *      （done=绿点 / running=旋转 / failed=红点）
 *   2. 点击展开：节点时间线（状态 + 耗时 + 正文预览 + 展开看产出）
 *   3. 「在画布中查看」→ /workflows/:flowId/canvas?run=<runId>（旁观模式）
 *
 * live 模式（发送中）：轮询 node-spans，节点逐个点亮 —— 与画布同一数据源。
 * 历史消息：挂载拉一次即定格。数据源与画布结果面板完全一致。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import { detectRefusal } from '@/lib/refusal-detect'
import { SPAN_STATUS_CN } from '@/lib/flows'
import { formatDuration } from '@/lib/format'
import '@/styles/workflow-run-card.css'

interface SpanRow {
  nodeId?: string
  node_id?: string
  nodeLabel?: string | null
  status?: string
  error?: string | null
  durationMs?: number | null
  tokens?: unknown
  output?: Record<string, unknown> | string | null
}

export interface WorkflowRunCardProps {
  runId: string
  flowName?: string | null
  flowId?: string | null
  /** 发送中的实时模式：轮询直到终态。 */
  live?: boolean
  /** 终态回调（live 模式下触发一次，父组件刷新 runs 映射）。 */
  onTerminal?: () => void
  /** 初始展开（PRD F4：聊天详情的执行记录默认可见）。 */
  defaultOpen?: boolean
}

function spanText(sp: SpanRow | undefined): string {
  const out = sp?.output
  if (out == null) return ''
  if (typeof out === 'string') return out
  const o = out as Record<string, unknown>
  let text = typeof o.text === 'string' && o.text ? o.text
    : typeof o.content === 'string' && o.content ? o.content
    : null
  // DirectReply 的 content 常是字符串化的上游 JSON —— 二次解包
  if (text && text.trimStart().startsWith('{')) {
    try {
      const inner = JSON.parse(text) as Record<string, unknown>
      if (typeof inner.text === 'string' && inner.text) text = inner.text
      else if (typeof inner.content === 'string' && inner.content) text = inner.content
    } catch { /* 原样 */ }
  }
  if (text) return text
  return JSON.stringify(out).slice(0, 140)
}

export function WorkflowRunCard({ runId, flowName, flowId, live = false, onTerminal, defaultOpen }: WorkflowRunCardProps): React.ReactElement | null {
  const { t } = useI18n()
  const [spans, setSpans] = useState<SpanRow[]>([])
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  // 默认展开（PRD F4）：聊天详情执行记录默认可见；live 卡保持自动展开 +
  // 手动收起记忆的既有行为。
  const [open, setOpen] = useState(defaultOpen ?? false)
  const [loaded, setLoaded] = useState(false)
  // Set when every fetch attempt has failed so far — surfaced as a retryable
  // inline error instead of an eternal spinner.
  const [fetchError, setFetchError] = useState<string | null>(null)
  const terminalFiredRef = useRef(false)
  const pollRef = useRef<number | undefined>(undefined)

  const fetchOnce = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/node-spans`, { cache: 'no-store' })
      if (!res.ok) {
        setFetchError(`HTTP ${res.status}`)
        return null
      }
      const body = (await res.json()) as {
        data?: { runStatus?: string | null; runDurationMs?: number | null; spans?: SpanRow[] }
      }
      setSpans(body?.data?.spans ?? [])
      setRunStatus(body?.data?.runStatus ?? null)
      if (body?.data?.runDurationMs != null) setDurationMs(body.data.runDurationMs)
      setLoaded(true)
      setFetchError(null)
      return body?.data?.runStatus ?? null
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [runId])

  useEffect(() => {
    let cancelled = false
    terminalFiredRef.current = false
    void fetchOnce().then((status) => {
      if (cancelled) return
      if (live && status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
        pollRef.current = window.setInterval(async () => {
          const st = await fetchOnce()
          if (cancelled) return
          if (st === 'completed' || st === 'failed' || st === 'cancelled') {
            window.clearInterval(pollRef.current)
            if (!terminalFiredRef.current) {
              terminalFiredRef.current = true
              onTerminal?.()
            }
          }
        }, 700)
      }
    })
    return () => {
      cancelled = true
      window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, live])

  const totalTokens = spans.reduce((acc, sp) => {
    const u = sp.tokens as { inputTokens?: number; outputTokens?: number } | null | undefined
    if (!u) return acc
    return { in: acc.in + (u.inputTokens ?? 0), out: acc.out + (u.outputTokens ?? 0) }
  }, { in: 0, out: 0 })
  const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const hasTokens = totalTokens.in > 0 || totalTokens.out > 0

  // 诚实标注：CLI 回复含权限拒绝话术时黄警 —— done 完成的是"放弃并解释"，
  // 不标注会把失败伪装成成功（2026-08-24 权限事故的教训）。
  // 每条 span 只算一次（此前同一 span 在进度链/时间线/统计里重复检测 3 次）。
  const spanFlags = useMemo(
    () => spans.map((sp) => ({
      sp,
      refused: sp.status === 'done' && detectRefusal(spanText(sp)),
      text: spanText(sp),
    })),
    [spans],
  )
  const refusedNodes = spanFlags.filter((f) => f.refused).map((f) => f.sp.nodeLabel || f.sp.nodeId)
  const hasRefusal = refusedNodes.length > 0

  const dur = durationMs != null ? formatDuration(durationMs) : null
  const title = flowName || runId.slice(0, 8)

  return (
    <div className={`wf-run-card${runStatus === 'failed' ? ' failed' : ''}${hasRefusal ? ' warn' : ''}${runStatus === 'running' || (live && !runStatus) ? ' running' : ''}`}>
      <button type='button' className='wf-run-card-head' onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {hasRefusal ? (
          <span className='wf-run-warn-flag' title={refusedNodes.join('、')}>⚠ {t('疑似权限受限')}</span>
        ) : null}
        <span className='wf-run-badge' aria-hidden='true'>⚡</span>
        <span className='wf-run-kind'>{t('工作流')}</span>
        <span className='wf-run-flow' title={title}>{title}</span>
        <span className='wf-run-chain' aria-hidden='true'>
          {spanFlags.map(({ sp, refused }) => {
            const st = refused ? 'warn' : sp.status ?? ''
            return (
              <span
                key={sp.nodeId ?? sp.node_id}
                className={`wf-chain-node dot-${st || 'pending'}`}
                title={`${sp.nodeLabel || sp.nodeId} · ${refused ? t('疑似权限受限') : t(SPAN_STATUS_CN[st] ?? st)}`}
              />
            )
          })}
          {!loaded && live ? <span className='wf-chain-loading' /> : null}
        </span>
        <span className='wf-run-meta'>
          {dur ? `${dur}` : ''}
          {hasTokens ? `${dur ? ' · ' : ''}↑${fmtTok(totalTokens.in)} ↓${fmtTok(totalTokens.out)}` : ''}
        </span>
        <span className={`wf-run-chevron${open ? ' open' : ''}`} aria-hidden='true'>▾</span>
      </button>

      {open ? (
        <div className='wf-run-timeline'>
          {spanFlags.map(({ sp, refused, text }) => {
            const id = sp.nodeId ?? sp.node_id ?? '?'
            const st = refused ? 'warn' : sp.status ?? ''
            return (
              <details key={id} className={`wf-tl-row status-${st}`} open={st === 'failed' || undefined}>
                <summary>
                  <span className={`wf-tl-dot dot-${st}`} aria-hidden='true' />
                  <span className='wf-tl-label'>{sp.nodeLabel || id}</span>
                  <span className='wf-tl-meta'>
                    {st === 'warn'
                      ? `⚠ ${t('疑似权限受限')}`
                      : t(SPAN_STATUS_CN[st] ?? st) || st}
                    {sp.durationMs != null ? ` · ${formatDuration(sp.durationMs)}` : ''}
                  </span>
                </summary>
                {sp.error ? <div className='wf-tl-error'>{sp.error}</div> : null}
                {text ? <div className='wf-tl-text'>{text}</div> : null}
              </details>
            )
          })}
          {spans.length === 0 && fetchError ? (
            <div className='wf-tl-empty' style={{ color: 'var(--danger)' }}>
              {t('执行进度加载失败：{error}', { error: fetchError })}{' '}
              <button type='button' className='btn btn-ghost btn-sm' onClick={() => void fetchOnce()}>
                {t('重试')}
              </button>
            </div>
          ) : null}
          {spans.length === 0 && !fetchError ? <div className='wf-tl-empty'>{t('（尚无节点执行记录）')}</div> : null}
          {flowId ? (
            <a className='wf-run-canvas-link' href={`/workflows/${flowId}/canvas?run=${runId}`}>
              {t('在画布中查看')} →
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 对称设计：非工作流的 assistant 回复挂一个轻量「🤖 Agent」来源徽章。 */
export function AgentSourceBadge({ agentName }: { agentName?: string | null }): React.ReactElement {
  const { t } = useI18n()
  return (
    <div className='wf-run-card agent-badge-only'>
      <div className='wf-run-card-head static'>
        <span className='wf-run-badge agent' aria-hidden='true'>🤖</span>
        <span className='wf-run-kind'>{t('Agent')}</span>
        {agentName ? <span className='wf-run-flow'>{agentName}</span> : null}
      </div>
    </div>
  )
}
