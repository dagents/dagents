/**
 * AgentActivitySparkline — 30-bucket daily activity bar chart (v0.3-M4.1).
 *
 * Ports design/agent-detail.html:227-245 `renderActivity`'s SVG: an
 * `.act-chart` SVG (viewBox `0 0 600 120`) with one `.act-chart-bar` rect per
 * 30-day bucket, height ∝ bucket.total / max, plus a stacked red
 * `.act-chart-bar.fail` rect on top whose height ∝ bucket.fail / total. The
 * chart is aria-labeled with the totals so screen readers get the shape
 * without the bars; the KPI row (rendered by the page, not here) carries the
 * numeric rollup.
 *
 * ## Why a component, not raw markup
 *
 * The design emitted a template-string of `<rect>`s via innerHTML. In React
 * the bars are an array of `<rect>` keyed by bucket index — the only
 * presentation logic worth extracting, because the same derivation is unit-
 * tested in `agent-detail.ts` (`deriveActivityBuckets`) and the SVG geometry
 * is pure given that array. Kept a leaf component (no fetch, no state) so it
 * renders deterministically under jsdom for the sparkline fidelity test.
 *
 * ## Geometry
 *
 * Matches the design's math exactly (W=600, H=120, PAD=8, bar width =
 * `(W - PAD*2) / count`, bar height = `(total / max) * (H - PAD*2)`, fail
 * height = `(fail / total) * barHeight`). `max` floored at 1 so an all-zero
 * history still draws zero-height bars (not NaN). Rect width floored at 0.8
 * and height at 0.5 (design's `Math.max(0.8, …)` / `Math.max(0.5, …)`).
 */

import type { AgentActivityBucket } from '@/lib/agent-detail'
import { sumBuckets } from '@/lib/agent-detail'

export interface AgentActivitySparklineProps {
  /** 30 daily buckets, oldest→newest (bucket 0 = 29 days ago, 29 = today).
   *  Any length is accepted (the design pads to 30); the chart lays bars
   *  evenly across the viewBox regardless. */
  buckets: ReadonlyArray<AgentActivityBucket>
  /** Optional aria-label override; defaults to a totals summary. */
  ariaLabel?: string
}

const CHART_W = 600
const CHART_H = 120
const PAD = 8

/** A single bar's rects (one ok rect + one optional fail overlay). */
interface BarRects {
  key: number
  okRect: { x: number; y: number; width: number; height: number }
  failRect: { x: number; y: number; width: number; height: number } | null
}

/**
 * Pure geometry for the sparkline bars — extracted so the fidelity test can
 * assert bar count, fail-overlay presence, and bar heights without going
 * through the DOM. Returns one entry per bucket; `failRect` is null when the
 * bucket has zero failures (matching the design's `b.fail > 0` guard).
 */
export function sparklineBarGeometry(
  buckets: ReadonlyArray<AgentActivityBucket>,
): BarRects[] {
  const count = Math.max(1, buckets.length)
  const max = Math.max(1, ...buckets.map((b) => b.total))
  const bw = (CHART_W - PAD * 2) / count
  const usable = CHART_H - PAD * 2
  return buckets.map((b, i) => {
    const h = (b.total / max) * usable
    const fh = b.fail > 0 && b.total > 0 ? (b.fail / b.total) * h : 0
    const x = PAD + i * bw
    const y = CHART_H - PAD - h
    const fy = CHART_H - PAD - fh
    const width = Math.max(0.8, bw - 0.5)
    const okRect = {
      x,
      y,
      width,
      height: Math.max(0.5, h),
    }
    const failRect =
      b.fail > 0 && b.total > 0
        ? { x, y: fy, width, height: Math.max(0.5, fh) }
        : null
    return { key: i, okRect, failRect }
  })
}

export function AgentActivitySparkline({
  buckets,
  ariaLabel,
}: AgentActivitySparklineProps): React.ReactElement {
  const bars = sparklineBarGeometry(buckets)
  const { total, fail } = sumBuckets(buckets)
  const label =
    ariaLabel ?? `30 天运行趋势，总 ${total} 次，失败 ${fail} 次`
  return (
    <svg
      className="act-chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {bars.map((bar) => (
        <g key={bar.key}>
          <rect
            className="act-chart-bar"
            x={bar.okRect.x.toFixed(1)}
            y={bar.okRect.y.toFixed(1)}
            width={bar.okRect.width.toFixed(1)}
            height={bar.okRect.height.toFixed(1)}
            rx={0.8}
          />
          {bar.failRect ? (
            <rect
              className="act-chart-bar fail"
              x={bar.failRect.x.toFixed(1)}
              y={bar.failRect.y.toFixed(1)}
              width={bar.failRect.width.toFixed(1)}
              height={bar.failRect.height.toFixed(1)}
              rx={0.8}
            />
          ) : null}
        </g>
      ))}
    </svg>
  )
}
