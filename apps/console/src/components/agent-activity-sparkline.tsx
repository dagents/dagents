/**
 * AgentActivitySparkline — 30-day activity line sparkline (PX-AD02, 2026-09-04).
 *
 * A single accent line (60% transparency) through one point per daily bucket,
 * height ∝ bucket.total / max, with a solid 3px dot on the most recent point.
 * Each bucket exposes a native SVG `<title>` tooltip ("N 天前 · 事件数") via a
 * full-height hit rect. Empty history renders a 24px flat dashed baseline +
 * 「暂无活动」 meta copy instead of a collapsed chart, and a meta row below
 * the chart carries the 7-day rollup.
 *
 * The page model (`deriveActivityBuckets` in lib/agent-detail.ts) is the data
 * truth; the geometry here is pure given that array, extracted so the unit
 * tests can pin point count / y-proportionality / last-point presence without
 * the DOM. Kept a leaf component (no fetch) so it renders deterministically
 * under jsdom.
 *
 * ## Geometry
 * W=600, H=120, PAD=8. Point x centers each bucket's slot:
 * `x = PAD + (i + 0.5) * (W - 2*PAD) / count`; `y = H - PAD - (total/max) *
 * (H - 2*PAD)` (max floored at 1 so all-zero history still resolves). The
 * stroke uses `vector-effect: non-scaling-stroke` so the stretched viewBox
 * (preserveAspectRatio="none") keeps a constant 2px weight.
 */

import type { AgentActivityBucket } from '@/lib/agent-detail'
import { sumBuckets } from '@/lib/agent-detail'
import { useI18n } from '@/i18n'

export interface AgentActivitySparklineProps {
  /** 30 daily buckets, oldest→newest (bucket 0 = 29 days ago, 29 = today).
   *  Any length is accepted (the derivation pads to 30); the chart lays
   *  points evenly across the viewBox regardless. */
  buckets: ReadonlyArray<AgentActivityBucket>
  /** Optional aria-label override; defaults to a totals summary. */
  ariaLabel?: string
}

const CHART_W = 600
const CHART_H = 120
const PAD = 8

/** A single day's plot point + its hover slot. */
export interface SparkPoint {
  key: number
  /** Plot point (slot center, value-scaled). */
  x: number
  y: number
  /** Full-height hover hit-slot for the native <title> tooltip. */
  hitX: number
  hitW: number
}

/**
 * Pure geometry for the sparkline points — extracted so the fidelity test can
 * assert point count and y-proportionality without going through the DOM.
 * One entry per bucket; y = baseline − (total/max)·usable, so the max bucket
 * touches the top padding and zero buckets sit on the baseline.
 */
export function sparklinePointGeometry(
  buckets: ReadonlyArray<AgentActivityBucket>,
): SparkPoint[] {
  const count = Math.max(1, buckets.length)
  const max = Math.max(1, ...buckets.map((b) => b.total))
  const usable = CHART_H - PAD * 2
  const slot = (CHART_W - PAD * 2) / count
  return buckets.map((b, i) => {
    const x = PAD + (i + 0.5) * slot
    const y = CHART_H - PAD - (b.total / max) * usable
    return { key: i, x, y, hitX: PAD + i * slot, hitW: slot }
  })
}

export function AgentActivitySparkline({
  buckets,
  ariaLabel,
}: AgentActivitySparklineProps): React.ReactElement {
  const { t } = useI18n()
  const points = sparklinePointGeometry(buckets)
  const { total, fail } = sumBuckets(buckets)
  // 7-day rollup (the trailing week of buckets) for the meta row below.
  const week = sumBuckets(buckets.slice(-7))
  const lineD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
  const label =
    ariaLabel ?? t('30 天运行趋势，总 {total} 次，失败 {fail} 次', { total, fail })

  return (
    <div className="act-sparkline">
      {total === 0 ? (
        // Empty history — flat dashed baseline + meta copy (PX-AD02)
        <div className="act-chart-empty" role="img" aria-label={label}>
          <span className="act-chart-empty-text">{t('暂无活动')}</span>
          <span className="act-chart-empty-line" aria-hidden="true" />
        </div>
      ) : (
        <svg
          className="act-chart"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          <path
            className="act-chart-line"
            d={lineD}
            fill="none"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {last ? (
            <circle
              className="act-chart-point"
              cx={last.x.toFixed(1)}
              cy={last.y.toFixed(1)}
              r={3}
            />
          ) : null}
          {/* Hover tooltips: full-height hit slots with native <title> */}
          {buckets.map((b, i) => {
            const p = points[i]
            if (!p) return null
            const daysAgo = buckets.length - 1 - i
            const dayLabel = daysAgo === 0 ? t('今天') : t('{n} 天前', { n: daysAgo })
            return (
              <rect
                key={p.key}
                className="act-chart-hit"
                x={p.hitX.toFixed(1)}
                y={0}
                width={Math.max(1, p.hitW - 1).toFixed(1)}
                height={CHART_H}
                fill="transparent"
              >
                <title>{t('{day} · {n} 次', { day: dayLabel, n: b.total })}</title>
              </rect>
            )
          })}
        </svg>
      )}
      <div className="act-axis-row" aria-hidden="true">
        <span>{t('30 天前')}</span>
        <span>{t('今天')}</span>
      </div>
      <div className="act-chart-meta">
        {t('近 7 天 {n} 次运行 · 失败 {fail} 次', { n: week.total, fail: week.fail })}
      </div>
    </div>
  )
}
