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
import { useI18n } from '@/i18n'
import {
  type UsageSummary,
  fetchUsageSummary,
  formatTokens,
  formatUsd,
  dayBars,
} from '@/lib/usage-summary'

const RANGE_OPTIONS = [7, 30, 90] as const

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
          <div className="muted mt-2" style={{ fontSize: 13 }}>
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
          >
            <Icon name="refresh" style={{ width: 14, height: 14 }} />
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
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 13,
          }}
        >
          {t('加载失败：{error}', { error })}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(days)}>
            {t('重试')}
          </button>
        </div>
      ) : loading && !summary ? (
        <div className="muted" style={{ padding: 'var(--space-12)', fontSize: 13 }}>
          {t('加载中…')}
        </div>
      ) : !hasData ? (
        <div className="empty-state">
          <div style={{ fontSize: 40, lineHeight: 1, opacity: 0.7 }} aria-hidden="true">🧾</div>
          <div className="h">{t('还没有用量记录')}</div>
          <div className="d">
            {t('执行一次对话或工作流后，实测 token 与成本会出现在这里。账单自埋点上线起累计，历史执行不回填。')}
          </div>
        </div>
      ) : (
        <>
          {/* 总览卡 */}
          <div className="usage-cards">
            <UsageCard
              label={t('成本')}
              value={formatUsd(summary?.totals.cost)}
              hint={t('已计价事件的成本合计')}
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
                    summary.byAgent.map((a) => (
                      <tr key={a.agentId ?? a.agentName}>
                        <td>
                          <span className="nm">{a.agentName ?? t('（已删除）')}</span>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{formatUsd(a.cost)}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{formatTokens(a.tokens)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {a.priced ? (
                            <span className="chip chip-outline" style={{ fontSize: 11 }}>{t('已计价')}</span>
                          ) : (
                            <span className="chip chip-outline" style={{ fontSize: 11 }}>{t('含未计价')}</span>
                          )}
                        </td>
                      </tr>
                    ))
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
                    summary.byFlow.map((f) => (
                      <tr key={f.flowId ?? f.flowName}>
                        <td>
                          <span className="nm">{f.flowName ?? t('（已删除）')}</span>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{formatUsd(f.cost)}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{formatTokens(f.tokens)}</td>
                      </tr>
                    ))
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

          <p className="muted mt-3" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {t('成本 = 实测 token × 模型单价（内置参考价可用环境变量 DAGENTS_PRICE_OVERRIDES 校正）。单价未知的模型只记 token，不计成本。')}
          </p>
        </>
      )}
    </section>
  )
}

function UsageCard(props: {
  label: string
  value: string
  hint: string
  warn?: boolean
}): React.ReactElement {
  const isZero = props.value === '—' || props.value === '0'
  return (
    <div className="card usage-card">
      <div className="muted" style={{ fontSize: 12 }}>{props.label}</div>
      <div
        className="mono"
        style={{
          fontSize: 22,
          fontWeight: 600,
          marginTop: 6,
          color: props.warn && !isZero ? 'var(--warn)' : undefined,
        }}
      >
        {props.value}
      </div>
      <div className="meta" style={{ fontSize: 11, marginTop: 4 }}>{props.hint}</div>
    </div>
  )
}

export default UsageTab
