'use client'

/**
 * Settings → 用量与成本 tab（方案 D / AD-3 账单页）。
 *
 * 数据只来自 gateway `GET /api/v1/usage/summary`（console BFF 纯代理），
 * 三块视图：总览卡（成本/token/未计价 token/事件数）、按天条形（纯 div
 * 宽度百分比，不引图表库）、按 Agent / 按 Flow 两张表。7/30/90 天窗口
 * 切换。所有数字为 gateway 聚合的实测值 —— 前端零折算（旧 flat $0.01/1k
 * 估算层已删，见 agents-catalog.ts deriveCost）。
 *
 * 「未计价」= 写入时单价未知的 token（usage_events.priced=false），
 * 价格表补齐后可回算重定价 —— 单列展示，绝不并入成本冒充实测。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/icon'
import { SkeletonList } from '@/components/skeleton'
import { useI18n } from '@/i18n'
import {
  type UsageByDay,
  type UsageSummary,
  fetchUsageSummary,
  formatTokens,
  formatUsd,
  dayBars,
} from '@/lib/usage-summary'

const RANGE_OPTIONS = [7, 30, 90] as const

/**
 * PX-ST04：把 formatTokens/formatUsd 的产物拆成「数值 + 单位」两段
 * （"12.3k" → ["12.3","k"]；"$1.23"/"<$0.01"/"—" 无尾随单位）——
 * 单位以 11px meta 挂尾，主数字保持大字号 + tabular-nums。
 */
function splitUnit(formatted: string): [value: string, unit: string] {
  const m = /^(.*?)(k|M)$/.exec(formatted)
  return m ? [m[1], m[2]] : [formatted, '']
}

/** 数字单元格的公共度量：mono + tabular-nums + 右对齐（px 值挂尾）。 */
const numCellStyle: React.CSSProperties = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

/** 单位后缀 —— 11px meta，随数字尾部。 */
function UnitSuffix({ unit }: { unit: string }): React.ReactElement | null {
  if (!unit) return null
  return (
    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--meta)', marginLeft: 2 }}>{unit}</span>
  )
}

export function UsageTab(props: { label: string }): React.ReactElement {
  const { t } = useI18n()
  const heading = props.label
  const [days, setDays] = useState<number>(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (range: number) => {
    setLoading(true)
    setError(null)
    try {
      setSummary(await fetchUsageSummary(range))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(days)
  }, [load, days])

  const bars = useMemo(() => dayBars(summary?.byDay ?? []), [summary])
  const hasData = (summary?.totals.events ?? 0) > 0

  return (
    <section className="settings-section active" aria-label={t(heading)}>
      <div className="row-between mb-4">
        <div>
          <div className="card-title" style={{ fontSize: 'var(--text-lg)' }}>{t(heading)}</div>
          <div className="muted mt-2" style={{ fontSize: 'var(--text-sm)' }}>
            {t('按实测 token 用量与模型单价汇总的成本账单。数据自埋点上线起累计，历史执行不回填。')}
          </div>
        </div>
        <div className="row-between" style={{ gap: 'var(--space-2)' }}>
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r}
              type="button"
              className="filter-chip"
              aria-pressed={days === r}
              onClick={() => setDays(r)}
            >
              {t('{n} 天', { n: r })}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load(days)}
            disabled={loading}
          >
            <Icon name={loading ? 'loader' : 'refresh'} style={{ width: 14, height: 14 }} />
            {t('刷新')}
          </button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: '10px 14px',
            marginBottom: 16,
            border: '1px solid var(--danger-soft)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--danger)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {t('加载失败：{error}', { error })}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(days)}>
            {t('重试')}
          </button>
        </div>
      ) : loading && !summary ? (
        <SkeletonList rows={4} />
      ) : !hasData ? (
        <div className="empty-state">
          <Icon name="dashboard" style={{ width: 40, height: 40, opacity: 0.7 }} aria-hidden="true" />
          <div className="h">{t('还没有用量记录')}</div>
          <div className="d">
            {t('执行一次对话或工作流后，实测 token 与成本会出现在这里。账单自埋点上线起累计，历史执行不回填。')}
          </div>
        </div>
      ) : (
        <div style={loading ? { opacity: 0.55, transition: 'opacity .15s', pointerEvents: 'none' } : { transition: 'opacity .15s' }}>
          {/* 总览卡（成本卡带 7d mini bar —— 纯 CSS 高度比例） */}
          <div className="usage-cards">
            <UsageCard
              label={t('成本')}
              value={formatUsd(summary?.totals.cost)}
              hint={t('已计价事件的成本合计')}
              mini={<UsageMiniBars byDay={summary?.byDay ?? []} />}
            />
            <UsageCard
              label={t('Token 用量')}
              value={formatTokens(summary?.totals.tokens)}
              hint={t('已计价事件的 token 合计')}
            />
            <UsageCard
              label={t('未计价 Token')}
              value={formatTokens(summary?.totals.unpricedTokens)}
              hint={t('单价未知的 token，价格表补齐后可回算')}
              warn
              zero={(summary?.totals.unpricedTokens ?? 0) === 0}
            />
            <UsageCard
              label={t('事件数')}
              value={String(summary?.totals.events ?? 0)}
              hint={t('对话 / 工作流 / 任务的终态记账条数')}
            />
          </div>

          {/* 按天条形（纯 div 宽度百分比） */}
          <div className="card mb-4">
            <div className="card-head">
              <div className="card-title">{t('按天成本')}</div>
              <span className="hint">{t('{n} 天窗口', { n: days })}</span>
            </div>
            <div className="usage-daybars">
              {bars.map((b) => (
                <div className="usage-daybar" key={b.date}>
                  <span className="date mono">{b.date.slice(5)}</span>
                  <div className="bar-track">
                    <span
                      className={`bar-fill${b.pct === 0 ? ' zero' : ''}`}
                      style={{ width: `${b.pct}%` }}
                    />
                  </div>
                  <span className="cost mono">{b.costLabel}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 按 Agent / 按 Flow 两张表 */}
          <div className="card mb-4">
            <div className="card-head">
              <div className="card-title">{t('按 Agent')}</div>
              <span className="hint">{t('仅统计对话路径（Agent 直接执行）')}</span>
            </div>
            <div className="table-wrap">
              <table className="data" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: '34%' }}>{t('Agent')}</th>
                    <th style={{ width: '22%', textAlign: 'right' }}>{t('成本')}</th>
                    <th style={{ width: '22%', textAlign: 'right' }}>{t('Token')}</th>
                    <th style={{ textAlign: 'right' }}>{t('计价状态')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary && summary.byAgent.length > 0 ? (
                    summary.byAgent.map((a) => {
                      const [tokVal, tokUnit] = splitUnit(formatTokens(a.tokens))
                      return (
                        <tr key={a.agentId ?? a.agentName}>
                          <td>
                            <span className="nm">{a.agentName ?? t('（已删除）')}</span>
                          </td>
                          <td className="mono" style={numCellStyle}>{formatUsd(a.cost)}</td>
                          <td className="mono" style={numCellStyle}>
                            {tokVal}<UnitSuffix unit={tokUnit} />
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {a.priced ? (
                              <span className="chip chip-outline" style={{ fontSize: 'var(--text-2xs)' }}>{t('已计价')}</span>
                            ) : (
                              <span className="chip chip-outline" style={{ fontSize: 'var(--text-2xs)' }}>{t('含未计价')}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={4} className="tc muted" style={{ padding: 'var(--space-12)' }}>
                        {t('窗口内没有 Agent 对话用量。')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">{t('按 Flow')}</div>
              <span className="hint">{t('工作流 run 的执行用量')}</span>
            </div>
            <div className="table-wrap">
              <table className="data" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: '34%' }}>{t('Flow')}</th>
                    <th style={{ width: '22%', textAlign: 'right' }}>{t('成本')}</th>
                    <th style={{ textAlign: 'right' }}>{t('Token')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary && summary.byFlow.length > 0 ? (
                    summary.byFlow.map((f) => {
                      const [tokVal, tokUnit] = splitUnit(formatTokens(f.tokens))
                      return (
                        <tr key={f.flowId ?? f.flowName}>
                          <td>
                            <span className="nm">{f.flowName ?? t('（已删除）')}</span>
                          </td>
                          <td className="mono" style={numCellStyle}>{formatUsd(f.cost)}</td>
                          <td className="mono" style={numCellStyle}>
                            {tokVal}<UnitSuffix unit={tokUnit} />
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={3} className="tc muted" style={{ padding: 'var(--space-12)' }}>
                        {t('窗口内没有工作流用量。')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p className="muted mt-3" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            {t('成本 = 实测 token × 模型单价（内置参考价可用环境变量 DAGENTS_PRICE_OVERRIDES 校正）。单价未知的模型只记 token，不计成本。')}
          </p>
        </div>
      )}
    </section>
  )
}

function UsageCard(props: {
  label: string
  value: string
  hint: string
  warn?: boolean
  /** Numeric zero (the formatted string '$0.00' never matched the old
   *  string check — 0 unpriced tokens still lit the warn color). */
  zero?: boolean
  /** Optional trailing visual (7d mini bar on the cost card). */
  mini?: React.ReactNode
}): React.ReactElement {
  const isZero = props.zero === true || props.value === '—'
  const [value, unit] = splitUnit(props.value)
  return (
    <div className="card usage-card">
      <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{props.label}</div>
      <div
        className="mono"
        style={{
          fontSize: 'var(--text-xl)',
          fontWeight: 600,
          marginTop: 6,
          color: props.warn && !isZero ? 'var(--warn)' : undefined,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.2,
        }}
      >
        {value}<UnitSuffix unit={unit} />
      </div>
      {props.mini}
      <div className="meta" style={{ fontSize: 'var(--text-2xs)', marginTop: 4 }}>{props.hint}</div>
    </div>
  )
}

/**
 * 7d mini bar（PX-ST04）—— 纯 CSS div 高度比例（max 日成本 → 100%），
 * 不引图表库。空数据（byDay 为空）不塌陷：返回 null，卡片高度由其余行撑住。
 */
function UsageMiniBars({ byDay }: { byDay: UsageByDay[] }): React.ReactElement | null {
  const days = byDay.slice(-7)
  if (days.length === 0) return null
  const max = Math.max(...days.map((d) => d.cost), 0)
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 3,
        height: 28,
        marginTop: 8,
      }}
    >
      {days.map((d) => {
        const pct = max > 0 ? Math.round((d.cost / max) * 100) : 0
        return (
          <span
            key={d.date}
            style={{
              flex: 1,
              minWidth: 4,
              height: pct > 0 ? `${Math.max(pct, 6)}%` : 2,
              background: pct > 0 ? 'var(--accent)' : 'var(--border)',
              borderRadius: 'var(--radius-xs)',
            }}
          />
        )
      })}
    </div>
  )
}

export default UsageTab
