'use client'

/**
 * 资源看板 (dashboard) view (M6.3 / P1.11.T4 + M5b.3 / P1.10.T9).
 *
 * Renders the five resource-dashboard cards the issue names: fleet density,
 * status distribution, 24h throughput, region, cost (plus a per-model token
 * usage table). Backed by the M6.5 aggregation API via the console's own
 * `/api/fleet-stats` proxy (browser → gateway → dispatch `GET /fleet-stats`).
 *
 * Data flow: this client component `fetchFleetStats` on mount + on window
 * change, derives the KPI/density/donut/throughput/region/usage views from the
 * pure mappers in `lib/fleet-stats.ts`, and renders the design's dashboard.html
 * DOM (ported to React). Page-local styles live in `styles/dashboard.css`;
 * `shell.css` provides the shared component classes (.kpi-row/.kpi/.card/.chip/
 * .segmented/.bar/.status/.row-between/.mono/.muted/.meta).
 *
 * Race safety: each reload spins up an `AbortController` and aborts the prior
 * in-flight fetch. A slow response to a superseded window can no longer land
 * after a faster one and overwrite the panel with the wrong window's data.
 *
 * Honesty about coverage: the dispatch API records which sources contributed
 * (`sources`) and whether the per-model rollup was capped (`usage.truncated`);
 * the view surfaces a "partial data" banner when either is true, instead of
 * mistaking absence for zero — matching the API's explicit honesty. The design's
 * 1M-agent density canvas and 24h area chart both need per-bucket / per-agent
 * state the single-snapshot API does not return; M5b.3 renders the density card
 * as a real task-status mosaic (`fleet.tasks.byStatus`) and the throughput card
 * as a numeric breakdown + runs/min rate, leaving the timeseries visuals for a
 * bucketed API. The five cards + KPI row + usage table are the MVP bar
 * ("看板可看，数据来自 runs + Langfuse + new-api").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PageShell } from '@/components/page-shell'
import '@/styles/dashboard.css'
import {
  FLEET_WINDOW_PRESETS,
  daemonSegments,
  daemonStatusColor,
  daemonStatusLabel,
  deriveDensityView,
  deriveKpis,
  deriveThroughputView,
  fetchFleetStats,
  formatCost,
  formatInt,
  formatRate,
  formatTokens,
  sortRegions,
  statusBadge,
  taskStatusColor,
  taskStatusLabel,
  usageRows,
  type FleetStats,
} from '@/lib/fleet-stats'

const C = 2 * Math.PI * 15.915 // donut circumference (r=15.915), for stroke-dash math

export function DashboardView(): React.ReactElement {
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The time-range segmented toggle's state is the design's preset token
  // (`1h`/`24h`/`7d`), not a numeric hours count — the toggle drives the
  // fetch URL (`?window=<token>`, the M8.1 plan's pinned shape). `windowLabel`
  // is derived from the active preset so KPI/card labels read "24h runs" /
  // "7d 成本" matching the selected window.
  const [window, setWindow] = useState<string>('24h')
  // The throughput card's metric segmented toggle (design:199-203): runs/min
  // is live; P95 延迟 + 失败率 are shape-aligned skeletons pending a bucketed
  // timeseries API (the single-snapshot fleet-stats response carries terminal
  // counts + rates, not per-bucket series).
  const [metric, setMetric] = useState<'runs' | 'p95' | 'fail'>('runs')
  const [refreshedAt, setRefreshedAt] = useState<string>('')

  // The in-flight fetch's aborter. Rapid window switches (1h→7d→1h) would let a
  // slow 7d response land after a faster 1h one and overwrite it with the wrong
  // window's data; aborting the previous fetch on each reload (window change or
  // manual refresh) guarantees only the latest request's result is committed.
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (w: string, signal?: AbortSignal): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const s = await fetchFleetStats(w, signal)
        setStats(s)
        setRefreshedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      } catch (err) {
        // A superseded fetch aborts — that is not a failure, so leave the prior
        // stats in place rather than blanking the panel to an error state.
        if (signal?.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setStats(null)
      } finally {
        // Only the active (latest) fetch owns the loading flag; an aborted one
        // must not flip it back to false while the replacement is still pending.
        if (!signal?.aborted) setLoading(false)
      }
    },
    [],
  )

  const reload = useCallback((): void => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    void load(window, ac.signal)
  }, [window, load])

  useEffect(() => {
    reload()
    return () => abortRef.current?.abort()
  }, [reload])

  const kpis = stats ? deriveKpis(stats) : null
  const badge = stats ? statusBadge(stats) : null
  const segs = stats ? daemonSegments(stats.fleet.daemons) : []
  const density = stats ? deriveDensityView(stats.fleet.tasks) : null
  const throughput = stats ? deriveThroughputView(stats) : null
  const regions = stats ? sortRegions(stats.regions) : []
  const usage = stats ? usageRows(stats.usage.byModel) : []
  const maxRegionAgents = regions.length > 0 ? Math.max(...regions.map((r) => r.agents), 1) : 1
  const windowLabel = FLEET_WINDOW_PRESETS.find((p) => p.window === window)?.label ?? window

  return (
    <PageShell
      title="资源看板"
      subtitle="Fleet 密度、状态分布、24h 吞吐、区域与成本。数据来源：runs 表（agent_daemon_calls）+ Langfuse + new-api（接入中）。"
      actions={
        <>
          <div className="segmented" role="group" aria-label="时间范围" data-testid="window-toggle">
            {FLEET_WINDOW_PRESETS.map((p) => (
              <button
                key={p.window}
                type="button"
                aria-pressed={window === p.window}
                onClick={() => setWindow(p.window)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={reload}
            disabled={loading}
          >
            刷新
          </button>
        </>
      }
    >
      {error ? (
        <div className="card" style={{ padding: 'var(--space-4)', color: 'var(--danger)' }}>
          加载失败：{error}。点{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
            刷新
          </button>{' '}
          重试。
        </div>
      ) : null}

      {badge && !error ? (
        <div className="dash-banner" role="status">
          <span className="sw" />
          <span>{badge}</span>
        </div>
      ) : null}

      {loading && !stats ? (
        <div className="dash-skel">
          <div className="sk kpi-row">
            <div className="sk kpi" />
            <div className="sk kpi" />
            <div className="sk kpi" />
            <div className="sk kpi" />
          </div>
          <div className="sk" style={{ height: 240 }} />
          <div className="sk" style={{ height: 180 }} />
        </div>
      ) : stats && kpis ? (
        <>
          {/* KPI row */}
          <div className="kpi-row mb-6">
            <Kpi label="注册 agents" value={formatInt(kpis.agents)} sub={`${formatInt(kpis.daemonsOnline)} daemons 在线`} />
            <Kpi
              label={`${windowLabel} runs`}
              value={formatInt(kpis.runs)}
              delta={`${kpis.runSuccessPct}% 成功`}
              deltaKind={kpis.runSuccessPct >= 90 ? 'up' : kpis.runSuccessPct >= 70 ? 'flat' : 'down'}
              sub={`任务 ${formatInt(kpis.tasks)}`}
            />
            <Kpi label="总 token" value={formatTokens(kpis.totalTokens)} sub={`${formatInt(stats.usage.totalCalls)} 次调用`} />
            <Kpi label={`${windowLabel} 成本`} value={formatCost(stats.cost.last24hCost)} sub={`累计 ${formatCost(stats.cost.totalCost)} · ${formatInt(stats.cost.runsCounted)} runs`} />
          </div>

          {/* fleet density + daemon status donut */}
          <div className="grid-12 mb-6">
            <div className="card col-8 density-card">
              <div className="density-head">
                <div className="t">Fleet 实时密度</div>
                <span className="chip chip-outline mono">{formatInt(density?.total ?? 0)} 任务</span>
                <span className="status running">
                  <span className="dot" />
                  实时
                </span>
              </div>
              {density && density.tiles.length > 0 ? (
                <div
                  className="density-grid"
                  role="img"
                  aria-label={`Fleet 任务密度图，共 ${formatInt(density.total)} 个任务`}
                >
                  {density.tiles.map((t, i) => (
                    <span
                      key={i}
                      className="density-tile"
                      style={{ background: taskStatusColor(t.status) }}
                      title={taskStatusLabel(t.status)}
                    />
                  ))}
                </div>
              ) : (
                <div className="density-empty">暂无在队任务</div>
              )}
              {density && density.legend.length > 0 ? (
                <div className="density-legend">
                  {density.legend.map((e) => (
                    <span key={e.status} className="li">
                      <span className="sw" style={{ background: taskStatusColor(e.status) }} />
                      {taskStatusLabel(e.status)} {formatInt(e.count)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="card col-4 donut-card">
              <div className="card-head">
                <div className="card-title">状态分布</div>
                <span className="chip chip-outline">{formatInt(stats.fleet.daemons.total)}</span>
              </div>
              {segs.length === 0 ? (
                <div className="donut-empty">暂无 daemon</div>
              ) : (
                <div className="donut-wrap">
                  <svg className="donut" viewBox="0 0 42 42" aria-label="Daemon 状态分布环形图">
                    <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--surface)" strokeWidth="6" />
                    {donutPaths(segs)}
                    <text className="donut-center" x="21" y="19.5" textAnchor="middle" dominantBaseline="middle">
                      {formatInt(stats.fleet.daemons.total)}
                    </text>
                    <text className="donut-center-sub" x="21" y="25.5" textAnchor="middle" dominantBaseline="middle">
                      daemons
                    </text>
                  </svg>
                  <div className="donut-legend">
                    {segs.map((s) => (
                      <div key={s.status} className="donut-row">
                        <span className="sw" style={{ background: daemonStatusColor(s.status) }} />
                        <span className="l">{daemonStatusLabel(s.status)}</span>
                        <span className="v">{formatInt(s.count)}</span>
                        <span className="pct">{Math.round(s.fraction * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="card col-8">
              <div className="card-head">
                <div className="card-title">24h 吞吐</div>
                <div className="segmented" role="group" aria-label="指标" data-testid="metric-toggle">
                  <button type="button" aria-pressed={metric === 'runs'} onClick={() => setMetric('runs')}>runs/min</button>
                  <button type="button" aria-pressed={metric === 'p95'} onClick={() => setMetric('p95')}>P95 延迟</button>
                  <button type="button" aria-pressed={metric === 'fail'} onClick={() => setMetric('fail')}>失败率</button>
                </div>
              </div>
              {throughput ? (
                <div className="throughput-grid" data-testid="throughput-grid">
                  {metric === 'runs' ? (
                    <>
                      <div className="throughput-cell">
                        <div className="throughput-big">{formatInt(throughput.runs.total)}</div>
                        <div className="throughput-lbl">runs 完成</div>
                        <div className="throughput-sub">
                          成功 {formatInt(throughput.runs.completed)} · 失败 {formatInt(throughput.runs.failed)}
                        </div>
                      </div>
                      <div className="throughput-cell">
                        <div className="throughput-big">{formatInt(throughput.tasks.total)}</div>
                        <div className="throughput-lbl">任务完成</div>
                        <div className="throughput-sub">
                          成功 {formatInt(throughput.tasks.completed)} · 失败 {formatInt(throughput.tasks.failed)}
                        </div>
                      </div>
                      <div className="throughput-cell">
                        <div className="throughput-big">
                          {formatRate(throughput.runsPerMin)}
                          <span className="throughput-unit"> /min</span>
                        </div>
                        <div className="throughput-lbl">runs 速率</div>
                        <div className="throughput-sub">任务 {formatRate(throughput.tasksPerMin)} /min</div>
                      </div>
                      <div className="throughput-cell">
                        <div className="throughput-big">{throughput.runSuccessPct}%</div>
                        <div className="throughput-lbl">run 成功率</div>
                        <div className="throughput-sub">{windowLabel} 窗口</div>
                      </div>
                    </>
                  ) : metric === 'p95' ? (
                    <div className="throughput-cell">
                      <div className="throughput-big">{formatRate(throughput.runsPerMin)}</div>
                      <div className="throughput-lbl">P95 延迟（骨架）</div>
                      <div className="throughput-sub">分桶时序待 timeseries API</div>
                    </div>
                  ) : (
                    <div className="throughput-cell">
                      <div className="throughput-big">{throughput.runSuccessPct}%</div>
                      <div className="throughput-lbl">失败率（骨架）</div>
                      <div className="throughput-sub">分桶时序待 timeseries API</div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="card col-4">
              <div className="card-head">
                <div className="card-title">区域资源占用</div>
                <span className="chip chip-outline">{formatInt(regions.length)} 区</span>
              </div>
              {regions.length === 0 ? (
                <div className="muted" style={{ padding: 'var(--space-8)', textAlign: 'center', fontSize: 'var(--text-xs)' }}>
                  暂无区域数据
                </div>
              ) : (
                regions.map((r, i) => {
                  const pct = Math.round((r.agents / maxRegionAgents) * 100)
                  return (
                    <div key={`${r.region}-${i}`} className="region-row">
                      <div className="region-name" title={r.region}>{r.region}</div>
                      <div className="region-bar">
                        <span className={i === 0 ? 'accent' : ''} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="region-num">{formatInt(r.agents)} agents</div>
                      <div className="region-pct">{formatCost(r.cost)}</div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* cost banner */}
          <div className="cost-banner mb-6">
            <div>
              <div className="big">{formatCost(stats.cost.last24hCost)}</div>
              <div className="lbl">{windowLabel} 累计成本</div>
            </div>
            <div className="div" />
            <div>
              <div className="big">{formatInt(stats.cost.runsCounted)}</div>
              <div className="lbl">计费 runs</div>
            </div>
            <div className="div" />
            <div className="cost-meter">
              <div className="row-between mb-2">
                <span className="muted" style={{ fontSize: 12 }}>累计 {formatCost(stats.cost.totalCost)}</span>
                <span className="mono" style={{ fontSize: 12 }}>{formatInt(stats.usage.totalCalls)} 调用</span>
              </div>
              <div className="bar">
                <span style={{ width: `${tokenSharePct(usage)}%` }} />
              </div>
              <div className="row-between mt-2">
                <span className="meta" style={{ fontSize: 11 }}>用量按模型分摊</span>
                <span className="meta" style={{ fontSize: 11 }}>{stats.usage.truncated ? '样本已截断' : '全量'}</span>
              </div>
            </div>
          </div>

          {/* per-model usage table */}
          <div className="card">
            <div className="card-head">
              <div className="card-title">模型用量分摊</div>
              <span className="chip chip-outline">{formatInt(usage.length)} 模型</span>
            </div>
            {usage.length === 0 ? (
              <div className="muted" style={{ padding: 'var(--space-8)', textAlign: 'center', fontSize: 'var(--text-xs)' }}>
                暂无用量数据
              </div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="data usage-table" data-testid="usage-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th className="num">输入</th>
                      <th className="num">输出</th>
                      <th className="num">缓存读</th>
                      <th className="num">调用</th>
                      <th>占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.map((u) => (
                      <tr key={u.model}>
                        <td className="mono">{u.model}</td>
                        <td className="num">{formatTokens(u.inputTokens)}</td>
                        <td className="num">{formatTokens(u.outputTokens)}</td>
                        <td className="num">{formatTokens(u.cacheReadTokens)}</td>
                        <td className="num">{formatInt(u.calls)}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                            <div className="bar-mini">
                              <span style={{ width: `${u.sharePct}%` }} />
                            </div>
                            <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', width: 32, textAlign: 'right' }}>
                              {u.sharePct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* snapshot footer */}
          <div className="dash-foot">
            <span>快照时间 {new Date(stats.generatedAt).toLocaleString('zh-CN')}</span>
            <span className="sep">|</span>
            <span>窗口 {formatInt(stats.windowHours)}h</span>
            <span className="sep">|</span>
            <span>来源 runs ✓{stats.sources.langfuse ? ' langfuse ✓' : ' langfuse ✗'}{stats.sources.newApi ? ' new-api ✓' : ' new-api ✗'}</span>
            {refreshedAt ? (
              <>
                <span className="sep">|</span>
                <span>本页刷新 {refreshedAt}</span>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </PageShell>
  )
}

function Kpi(props: {
  label: string
  value: string
  delta?: string
  deltaKind?: 'up' | 'down' | 'flat'
  sub?: string
}): React.ReactElement {
  const { label, value, delta, deltaKind = 'flat', sub } = props
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta ? <div className={`kpi-delta ${deltaKind}`}>{delta}</div> : null}
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  )
}

/**
 * Build the donut's `<circle>` segments. Mirrors design/dashboard.html's
 * convention: `rotate(-90)` puts the start at 12 o'clock, and
 * `stroke-dashoffset = C - startLen` positions each segment where the previous
 * one ended. No percentage-offset mixing.
 */
function donutPaths(segs: { status: string; fraction: number }[]): React.ReactElement {
  let startLen = 0
  const circles = segs.map((s) => {
    const len = s.fraction * C
    const el = (
      <circle
        key={s.status}
        cx="21"
        cy="21"
        r="15.915"
        fill="none"
        stroke={daemonStatusColor(s.status)}
        strokeWidth="6"
        strokeDasharray={`${len.toFixed(2)} ${(C - len).toFixed(2)}`}
        strokeDashoffset={(C - startLen).toFixed(2)}
        transform="rotate(-90 21 21)"
      />
    )
    startLen += len
    return el
  })
  return <g>{circles}</g>
}

/** The top model's share (0–100) — sizes the cost-meter usage bar. */
function tokenSharePct(usage: { sharePct: number }[]): number {
  return usage.length > 0 ? usage[0].sharePct : 0
}

export default DashboardView
