import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchFleetStats,
  parseCost,
  formatCost,
  formatInt,
  formatTokens,
  formatRate,
  deriveKpis,
  deriveDensityView,
  deriveThroughputView,
  sortRegions,
  usageRows,
  daemonSegments,
  daemonStatusLabel,
  daemonStatusColor,
  taskStatusLabel,
  taskStatusColor,
  statusBadge,
  windowToHours,
  FLEET_WINDOW_PRESETS,
  DENSITY_MAX_TILES,
  type FleetStats,
} from './fleet-stats'

/**
 * Unit tests for the fleet-stats client + pure mappers (M6.3 / P1.11.T4).
 *
 * Mirrors `agents-catalog.test.ts`'s posture: the pure formatting/derivation
 * helpers run in vitest's node environment with no network, no React, no DB —
 * they pin the dashboard's display math (cost string → `$x.xx`, token compaction,
 * KPI derivation, region sort, usage share, daemon donut fractions). The fetch
 * wrapper is exercised against a stubbed `global.fetch` feeding the real
 * `{ success, data }` envelope, the same way `tokens-client.test.ts` does.
 */

/** A minimal but representative snapshot covering every facet the view reads. */
const SNAPSHOT: FleetStats = {
  windowHours: 24,
  windowSince: '2026-07-08T12:57:00.000Z',
  generatedAt: '2026-07-09T12:57:00.000Z',
  fleet: {
    daemons: { byStatus: { online: 3, offline: 1, draining: 1 }, total: 5 },
    agents: { total: 42, byKind: { claude: 30, codex: 12 } },
    tasks: { byStatus: { running: 4, queued: 2 }, total: 6 },
  },
  throughput: {
    since: '2026-07-08T12:57:00.000Z',
    tasks: { completed: 80, failed: 4, total: 84 },
    runs: { completed: 76, failed: 4, total: 80 },
  },
  regions: [
    { region: 'us-east-1', agents: 20, runs: 50, cost: '12.500000' },
    { region: 'ap-northeast', agents: 12, runs: 20, cost: '4.200000' },
    { region: 'unknown', agents: 8, runs: 0, cost: '0.000000' },
  ],
  cost: { totalCost: '16.700000', last24hCost: '4182.5', runsCounted: 9 },
  usage: {
    byModel: {
      'claude-sonnet': {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 10_000,
        calls: 30,
      },
      'gpt-4o': {
        inputTokens: 100_000,
        outputTokens: 50_000,
        calls: 12,
      },
    },
    totalCalls: 42,
    truncated: false,
  },
  sources: { runs: true, langfuse: false, newApi: false },
}

describe('FLEET_WINDOW_PRESETS / windowToHours', () => {
  it('pairs every preset token with its hours + label', () => {
    // The M8.1 redesign carries the design's preset token on each preset; the
    // toggle drives `?window=<token>` while the numeric hours size the window.
    expect(FLEET_WINDOW_PRESETS.map((p) => p.window)).toEqual(['1h', '24h', '7d'])
    expect(FLEET_WINDOW_PRESETS.map((p) => p.hours)).toEqual([1, 24, 168])
    expect(FLEET_WINDOW_PRESETS.map((p) => p.label)).toEqual(['1h', '24h', '7d'])
  })

  it('resolves a preset token to its numeric hours', () => {
    expect(windowToHours('1h')).toBe(1)
    expect(windowToHours('24h')).toBe(24)
    expect(windowToHours('7d')).toBe(168)
  })

  it('returns null for an absent or unknown token', () => {
    expect(windowToHours(undefined)).toBeNull()
    expect(windowToHours('')).toBeNull()
    expect(windowToHours('30d')).toBeNull()
  })
})

describe('parseCost / formatCost', () => {
  it('parses a NUMERIC string to a number', () => {
    expect(parseCost('4182.5')).toBe(4182.5)
    expect(parseCost('0.000000')).toBe(0)
  })

  it('returns 0 for null / undefined / NaN', () => {
    expect(parseCost(null)).toBe(0)
    expect(parseCost(undefined)).toBe(0)
    expect(parseCost('not-a-number')).toBe(0)
  })

  it('formats to two decimals with a $ prefix', () => {
    expect(formatCost('4182.5')).toBe('$4182.50')
    expect(formatCost('0.000000')).toBe('$0.00')
    expect(formatCost(null)).toBe('$0.00')
    expect(formatCost(undefined)).toBe('$0.00')
  })
})

describe('formatInt', () => {
  it('adds thousands separators', () => {
    expect(formatInt(1_040_328)).toBe('1,040,328')
    expect(formatInt(0)).toBe('0')
  })

  it('returns 0 for null / undefined', () => {
    expect(formatInt(null)).toBe('0')
    expect(formatInt(undefined)).toBe('0')
  })
})

describe('formatTokens', () => {
  it('compacts large counts', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4K')
    expect(formatTokens(120_000)).toBe('120K')
    expect(formatTokens(3_200_000)).toBe('3.2M')
  })

  it('returns 0 for null / undefined', () => {
    expect(formatTokens(null)).toBe('0')
    expect(formatTokens(undefined)).toBe('0')
  })
})

describe('formatRate', () => {
  it('renders 0 for a near-zero rate', () => {
    expect(formatRate(0)).toBe('0')
    expect(formatRate(0.04)).toBe('0')
  })

  it('renders one decimal under 100', () => {
    expect(formatRate(1.23)).toBe('1.2')
    expect(formatRate(47.86)).toBe('47.9')
  })

  it('renders integers at/above 100, then compact K', () => {
    expect(formatRate(100)).toBe('100')
    expect(formatRate(824.7)).toBe('825')
    expect(formatRate(1140)).toBe('1.1K')
  })

  it('returns 0 for null / undefined', () => {
    expect(formatRate(null)).toBe('0')
    expect(formatRate(undefined)).toBe('0')
  })
})

describe('deriveDensityView', () => {
  it('tiles one cell per task, grouped into contiguous status bands', () => {
    // SNAPSHOT.fleet.tasks = { byStatus: { running: 4, queued: 2 }, total: 6 }
    const view = deriveDensityView(SNAPSHOT.fleet.tasks)
    expect(view.total).toBe(6)
    expect(view.tiles).toHaveLength(6)
    // running (4) > queued (2) so running leads; tiles group by status, contiguous
    expect(view.tiles.slice(0, 4).every((t) => t.status === 'running')).toBe(true)
    expect(view.tiles.slice(4, 6).every((t) => t.status === 'queued')).toBe(true)
    // legend sorted by count desc, carrying the true counts (not the tile count)
    expect(view.legend.map((e) => e.status)).toEqual(['running', 'queued'])
    expect(view.legend[0].count).toBe(4)
  })

  it('yields 0 tiles + 0 legend for an empty queue', () => {
    const view = deriveDensityView({ byStatus: {}, total: 0 })
    expect(view.tiles).toEqual([])
    expect(view.legend).toEqual([])
    expect(view.total).toBe(0)
  })

  it('drops zero-count statuses (schema noise) from tiles + legend', () => {
    const view = deriveDensityView({
      byStatus: { running: 2, completed: 0, failed: 0 },
      total: 2,
    })
    expect(view.tiles).toHaveLength(2)
    expect(view.legend.map((e) => e.status)).toEqual(['running'])
  })

  it('truncates to maxTiles, highest-count statuses first, but keeps the true total', () => {
    // 10 running + 2 queued, capped at 5 → 5 running tiles, total still 12
    const view = deriveDensityView(
      { byStatus: { running: 10, queued: 2 }, total: 12 },
      5,
    )
    expect(view.tiles).toHaveLength(5)
    expect(view.tiles.every((t) => t.status === 'running')).toBe(true)
    expect(view.total).toBe(12) // true count, not the capped tile count
    // legend still reports the true per-status counts (running 10, queued 2)
    expect(view.legend.map((e) => e.status)).toEqual(['running', 'queued'])
  })

  it('default cap equals DENSITY_MAX_TILES', () => {
    // A fleet well over the cap truncates at the exported default, not infinity.
    const big = deriveDensityView({ byStatus: { running: DENSITY_MAX_TILES + 50 }, total: DENSITY_MAX_TILES + 50 })
    expect(big.tiles).toHaveLength(DENSITY_MAX_TILES)
    expect(big.total).toBe(DENSITY_MAX_TILES + 50)
  })
})

describe('deriveThroughputView', () => {
  it('surfaces terminal counts + per-minute rates + success rate', () => {
    // SNAPSHOT: 24h window, runs {76,4,80}, tasks {80,4,84}
    const v = deriveThroughputView(SNAPSHOT)
    expect(v.runs.total).toBe(80)
    expect(v.tasks.total).toBe(84)
    expect(v.runSuccessPct).toBe(95)
    // 80 runs / (24*60 min) = 0.0556/min
    expect(v.runsPerMin).toBeCloseTo(80 / (24 * 60), 6)
    expect(v.tasksPerMin).toBeCloseTo(84 / (24 * 60), 6)
    expect(v.windowHours).toBe(24)
  })

  it('yields 0 rates for a zero-hour window (no Infinity)', () => {
    const s: FleetStats = { ...SNAPSHOT, windowHours: 0 }
    const v = deriveThroughputView(s)
    expect(v.runsPerMin).toBe(0)
    expect(v.tasksPerMin).toBe(0)
  })

  it('yields 0 success rate when no terminal runs', () => {
    const s: FleetStats = {
      ...SNAPSHOT,
      throughput: { ...SNAPSHOT.throughput, runs: { completed: 0, failed: 0, total: 0 } },
    }
    expect(deriveThroughputView(s).runSuccessPct).toBe(0)
  })
})

describe('taskStatusLabel / taskStatusColor', () => {
  it('maps known dispatch_task lifecycle statuses to labels + colors', () => {
    expect(taskStatusLabel('running')).toBe('运行中')
    expect(taskStatusLabel('queued')).toBe('排队')
    expect(taskStatusLabel('failed')).toBe('失败')
    // colors are CSS-var strings the view uses verbatim
    expect(taskStatusColor('running')).toBe('var(--accent)')
    expect(taskStatusColor('failed')).toBe('var(--danger)')
  })

  it('passes unknown statuses through verbatim (schema drift still visible)', () => {
    expect(taskStatusLabel('cancelled')).toBe('cancelled')
    expect(taskStatusColor('cancelled')).toBe('var(--border)')
  })
})

describe('deriveKpis', () => {
  it('sums agents, daemons online, terminal runs, tasks, cost, tokens', () => {
    const k = deriveKpis(SNAPSHOT)
    expect(k.agents).toBe(42)
    expect(k.daemonsOnline).toBe(3)
    expect(k.runs).toBe(80)
    expect(k.runSuccessPct).toBe(95) // 76 / 80
    expect(k.tasks).toBe(84)
    expect(k.last24hCost).toBe(4182.5)
    // claude(1.2M) + gpt(150K) = 1.35M
    expect(k.totalTokens).toBe(1_350_000)
  })

  it('returns a 0 success rate when no terminal runs (no divide-by-zero)', () => {
    const s: FleetStats = {
      ...SNAPSHOT,
      throughput: { ...SNAPSHOT.throughput, runs: { completed: 0, failed: 0, total: 0 } },
    }
    expect(deriveKpis(s).runSuccessPct).toBe(0)
  })

  it('treats a missing online status as 0 daemons online (schema drift)', () => {
    const s: FleetStats = {
      ...SNAPSHOT,
      fleet: { ...SNAPSHOT.fleet, daemons: { byStatus: { offline: 5 }, total: 5 } },
    }
    expect(deriveKpis(s).daemonsOnline).toBe(0)
  })
})

describe('sortRegions', () => {
  it('sorts by agent count descending (ties broken by runs)', () => {
    const out = sortRegions(SNAPSHOT.regions)
    expect(out.map((r) => r.region)).toEqual(['us-east-1', 'ap-northeast', 'unknown'])
  })

  it('does not mutate the input array', () => {
    const input = [...SNAPSHOT.regions]
    sortRegions(SNAPSHOT.regions)
    expect(SNAPSHOT.regions).toEqual(input)
  })
})

describe('usageRows', () => {
  it('projects models to rows sorted by total tokens desc with a share', () => {
    const rows = usageRows(SNAPSHOT.usage.byModel)
    expect(rows).toHaveLength(2)
    expect(rows[0].model).toBe('claude-sonnet') // 1.2M > 150K
    expect(rows[0].totalTokens).toBe(1_200_000)
    expect(rows[0].calls).toBe(30)
    // claude share = 1.2M / 1.35M ≈ 89%
    expect(rows[0].sharePct).toBe(89)
    expect(rows[1].model).toBe('gpt-4o')
    expect(rows[1].sharePct).toBe(11)
  })

  it('returns 0 share for every row when the fleet has no tokens', () => {
    const rows = usageRows({
      none: { inputTokens: 0, outputTokens: 0, calls: 0 },
    })
    expect(rows[0].sharePct).toBe(0)
    expect(rows[0].totalTokens).toBe(0)
  })

  it('returns [] for an empty usage map', () => {
    expect(usageRows({})).toEqual([])
  })

  it('coalesces absent optional token fields to 0', () => {
    const rows = usageRows({ m: { inputTokens: 5, outputTokens: 5, calls: 1 } })
    expect(rows[0].cacheReadTokens).toBe(0)
  })
})

describe('daemonSegments', () => {
  it('builds sorted fractions of the fleet total', () => {
    const segs = daemonSegments(SNAPSHOT.fleet.daemons)
    expect(segs.map((s) => s.status)).toEqual(['online', 'offline', 'draining'])
    expect(segs[0].count).toBe(3)
    expect(segs[0].fraction).toBeCloseTo(0.6, 5) // 3/5
  })

  it('returns [] for an empty fleet', () => {
    expect(daemonSegments({ byStatus: {}, total: 0 })).toEqual([])
  })

  it('yields 0 fractions when total is 0 but statuses exist', () => {
    const segs = daemonSegments({ byStatus: { online: 0 }, total: 0 })
    expect(segs[0].fraction).toBe(0)
  })
})

describe('daemonStatusLabel / daemonStatusColor', () => {
  it('maps known statuses to design labels + colors', () => {
    expect(daemonStatusLabel('online')).toBe('在线')
    expect(daemonStatusLabel('offline')).toBe('离线')
    expect(daemonStatusLabel('draining')).toBe('排空中')
    expect(daemonStatusColor('online')).toBe('var(--accent)')
  })

  it('passes unknown statuses through verbatim (schema drift still visible)', () => {
    expect(daemonStatusLabel('hung')).toBe('hung')
    expect(daemonStatusColor('hung')).toBe('var(--border)')
  })
})

describe('statusBadge', () => {
  it('is null when all sources contributed and the rollup is whole', () => {
    const full: FleetStats = {
      ...SNAPSHOT,
      sources: { runs: true, langfuse: true, newApi: true },
      usage: { ...SNAPSHOT.usage, truncated: false },
    }
    expect(statusBadge(full)).toBeNull()
  })

  it('flags Langfuse/new-api not yet wired', () => {
    expect(statusBadge(SNAPSHOT)).toContain('Langfuse/new-api 未接入')
  })

  it('flags a truncated rollup', () => {
    const s: FleetStats = { ...SNAPSHOT, usage: { ...SNAPSHOT.usage, truncated: true } }
    expect(statusBadge(s)).toContain('用量样本已截断')
  })

  it('joins both reasons when both apply', () => {
    const s: FleetStats = {
      ...SNAPSHOT,
      sources: { runs: true, langfuse: false, newApi: false },
      usage: { ...SNAPSHOT.usage, truncated: true },
    }
    expect(statusBadge(s)).toBe('Langfuse/new-api 未接入 · 用量样本已截断')
  })
})

// ─── fetch wrapper (stubbed global.fetch, real envelope) ───────────

function jsonRes(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(handler: (req: Request) => Response): {
  calls: { url: string }[]
} {
  const calls: { url: string }[] = []
  const BASE = 'http://localhost'
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const resolved = input instanceof Request ? input : new Request(new URL(String(input), BASE), init)
    calls.push({ url: new URL(resolved.url).pathname + new URL(resolved.url).search })
    return handler(resolved)
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchFleetStats', () => {
  it('GETs /api/fleet-stats with no query when window omitted', async () => {
    const { calls } = mockFetch(() => jsonRes({ success: true, data: SNAPSHOT }))
    const out = await fetchFleetStats()
    expect(calls[0].url).toBe('/api/fleet-stats')
    expect(out).toEqual(SNAPSHOT)
  })

  it('appends ?window=<preset> when a window token is given', async () => {
    // The M8.1 redesign sends the design's preset token (`7d`), not a numeric
    // `windowHours`, so the toggle drives `?window=7d` (the proxy resolves it
    // to the dispatch `windowHours` upstream). `windowToHours` maps the token
    // to hours; this asserts the wire shape, not the hours.
    const { calls } = mockFetch(() => jsonRes({ success: true, data: SNAPSHOT }))
    await fetchFleetStats('7d')
    expect(calls[0].url).toBe('/api/fleet-stats?window=7d')
  })

  it('throws the envelope error on a non-success', async () => {
    mockFetch(() => jsonRes({ success: false, error: 'upstream error' }, { status: 502 }))
    await expect(fetchFleetStats()).rejects.toThrow('upstream error')
  })

  it('throws a status-bearing fallback when the response is not JSON', async () => {
    mockFetch(
      () =>
        new Response('plain text', { status: 502, headers: { 'content-type': 'text/plain' } }),
    )
    await expect(fetchFleetStats()).rejects.toThrow(/fleet stats failed/)
  })

  it('aborts when the caller passes an already-aborted signal', async () => {
    // The view aborts superseded fetches on a window switch; a fetch whose
    // signal is already aborted must reject (with AbortError) before resolving
    // — otherwise the superseded response would land and overwrite the panel.
    mockFetch(() => jsonRes({ success: true, data: SNAPSHOT }))
    const ac = new AbortController()
    ac.abort()
    await expect(fetchFleetStats('24h', ac.signal)).rejects.toThrow(/abort/i)
  })
})

// ─── contract snapshot: the dispatch server's real payload shape ──────
//
// The unit `SNAPSHOT` above is a hand-rolled fixture convenient for the
// formatter/KPI assertions. This block pins the *backend's* real
// `GET /fleet-stats` shape (apps/dispatch/src/routes/fleet-stats.ts, asserted
// by apps/dispatch/src/__tests__/fleet-stats.test.ts). It runs the full
// projection (deriveKpis + daemonSegments + usageRows + statusBadge) against
// that real shape so a future drift — e.g. flattening `fleet.daemons` again —
// fails here instead of silently reading `undefined` at runtime.

const BACKEND_PAYLOAD: FleetStats = {
  windowHours: 24,
  windowSince: '2026-07-08T12:57:00.000Z',
  generatedAt: '2026-07-09T12:57:00.000Z',
  fleet: {
    daemons: { byStatus: { online: 1, draining: 1 }, total: 2 },
    agents: { total: 2, byKind: { claude: 1, codex: 1 } },
    tasks: { byStatus: { completed: 1, queued: 1 }, total: 2 },
  },
  throughput: {
    since: '2026-07-08T12:57:00.000Z',
    tasks: { completed: 1, failed: 0, total: 2 },
    runs: { completed: 1, failed: 0, total: 1 },
  },
  regions: [{ region: 'unknown', agents: 2, runs: 1, cost: '0.000000' }],
  cost: { totalCost: '0.000000', last24hCost: '0.000000', runsCounted: 1 },
  usage: { byModel: {}, totalCalls: 0, truncated: false },
  sources: { runs: true, langfuse: false, newApi: false },
}

describe('backend payload contract (dispatch shape)', () => {
  it('deriveKpis reads fleet.agents.total + fleet.daemons.byStatus.online', () => {
    const k = deriveKpis(BACKEND_PAYLOAD)
    expect(k.agents).toBe(2)
    expect(k.daemonsOnline).toBe(1)
    expect(k.runs).toBe(1)
    expect(k.runSuccessPct).toBe(100)
  })

  it('daemonSegments reads fleet.daemons.{byStatus,total}', () => {
    const segs = daemonSegments(BACKEND_PAYLOAD.fleet.daemons)
    expect(segs.map((s) => s.status)).toEqual(['online', 'draining'])
    expect(segs[0].fraction).toBeCloseTo(0.5, 5)
  })

  it('usageRows reads usage.byModel without cacheWriteTokens in the row', () => {
    const rows = usageRows(BACKEND_PAYLOAD.usage.byModel)
    expect(rows).toEqual([])
    // the row type carries no cacheWriteTokens field at all
    expect('cacheWriteTokens' in (rows[0] ?? {})).toBe(false)
  })

  it('statusBadge flags the not-yet-wired sources', () => {
    expect(statusBadge(BACKEND_PAYLOAD)).toContain('Langfuse/new-api 未接入')
  })

  // M5b.3 additions: the density + throughput cards derive from facets the
  // real backend payload carries (fleet.tasks + throughput), so the contract
  // block pins them against the dispatch shape too — a drift in either facet
  // fails here instead of rendering an empty card at runtime.
  it('deriveDensityView reads fleet.tasks.{byStatus,total}', () => {
    const v = deriveDensityView(BACKEND_PAYLOAD.fleet.tasks)
    expect(v.total).toBe(2)
    expect(v.tiles).toHaveLength(2)
    // completed + queued both present; ties broken by status asc (completed < queued)
    expect(v.legend.map((e) => e.status)).toEqual(['completed', 'queued'])
  })

  it('deriveThroughputView reads throughput + windowHours', () => {
    const v = deriveThroughputView(BACKEND_PAYLOAD)
    expect(v.runs.total).toBe(1)
    expect(v.tasks.total).toBe(2)
    expect(v.runSuccessPct).toBe(100)
    expect(v.windowHours).toBe(24)
  })
})
