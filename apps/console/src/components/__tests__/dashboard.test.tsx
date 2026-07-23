/**
 * Dashboard view fidelity tests (v0.3-M8.1).
 *
 * Pins the design/dashboard.html DOM + the time-window segmented toggle the
 * redesign moves `dashboard-view.tsx` onto — the M8.1 acceptance surface:
 * KPI row + fleet density + daemon donut + 24h throughput + region + per-model
 * usage table + 时间窗 segmented toggle (state `window` → fetch `?window=`).
 *
 * `global.fetch` is stubbed to a `MOCK_FLEET` envelope (the same dispatch
 * `GET /fleet-stats` shape `lib/fleet-stats.test.ts`'s `SNAPSHOT` carries) so
 * the suite runs without a gateway. The view's `fetchFleetStats` GETs
 * `/api/fleet-stats?window=<preset>`; the toggle test captures the spy to
 * assert a 7d click re-fetches with `?window=7d`.
 *
 * No `next/navigation` / `next/link` mock is needed — the dashboard renders
 * inside `PageShell` (no router), and fetches via the console's own
 * `/api/fleet-stats` proxy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FleetStats } from '@/lib/fleet-stats'

// ─── fixture ──────────────────────────────────────────────────────────────

/**
 * A minimal but representative dispatch `GET /fleet-stats` snapshot covering
 * every facet the view renders (fleet / throughput / regions / cost / usage /
 * sources). Mirrors `lib/fleet-stats.test.ts`'s `SNAPSHOT` so the contract is
 * the same one the pure-mapper unit tests already pin.
 */
const MOCK_FLEET: FleetStats = {
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
      'gpt-4o': { inputTokens: 100_000, outputTokens: 50_000, calls: 12 },
    },
    totalCalls: 42,
    truncated: false,
  },
  sources: { runs: true, langfuse: false, newApi: false },
}

// ─── fetch stub ──────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  // A fresh `Response` per call — the view re-fetches on every window switch
  // and reads `.json()`; a single shared `mockResolvedValue` body throws
  // "Body is unusable: Body has already been read" on the second fetch.
  globalThis.fetch = vi.fn().mockImplementation(() =>
    Promise.resolve(jsonResponse({ success: true, data: MOCK_FLEET })),
  ) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

// Imported lazily so the `globalThis.fetch` stub above is in place before the
// view's module-eval + mount effects run.
async function renderView(): Promise<void> {
  const { DashboardView } = await import('@/components/dashboard-view')
  render(<DashboardView />)
}

// ─── §M8.1 KPI row + density + donut + usage table ───────────────────────────

describe('DashboardView — KPI row + density + donut + usage table (M8.1)', () => {
  it('renders the KPI row, fleet density, daemon donut, and usage table', async () => {
    await renderView()
    // KPI row — "注册 agents" is the first KPI's label (dashboard-view Kpi).
    expect(await screen.findByText(/注册 agents/i)).toBeInTheDocument()
    // Fleet density card title (design/dashboard.html:162).
    expect(screen.getByText(/Fleet 实时密度/i)).toBeInTheDocument()
    // Daemon status-distribution donut card title (design:181) — scoped to
    // the donut card so the subtitle's "状态分布" mention doesn't double-match.
    expect(screen.getByText('状态分布', { selector: '.card-title' })).toBeInTheDocument()
    // 24h throughput card title (design:198) — scoped to the card title so
    // the page subtitle's "24h 吞吐" mention doesn't double-match.
    expect(screen.getByText(/24h 吞吐/i, { selector: '.card-title' })).toBeInTheDocument()
    // Per-model usage table carries the testid the M8.1 plan names.
    expect(screen.getByTestId('usage-table')).toBeInTheDocument()
    // Region card title (design:216).
    expect(screen.getByText(/区域资源占用/i)).toBeInTheDocument()
    // A model row renders (claude-sonnet leads by token volume).
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument()
  })

  it('renders the three window presets with 24h pressed by default', async () => {
    await renderView()
    const h1 = screen.getByRole('button', { name: '1h' })
    const h24 = screen.getByRole('button', { name: '24h' })
    const d7 = screen.getByRole('button', { name: '7d' })
    // 24h is the default window (matches design/dashboard.html:122).
    expect(h24).toHaveAttribute('aria-pressed', 'true')
    expect(h1).toHaveAttribute('aria-pressed', 'false')
    expect(d7).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders the throughput card with the metric segmented toggle (runs/min default)', async () => {
    await renderView()
    // The 24h throughput card carries the design's metric segmented toggle
    // (design/dashboard.html:199-203): runs/min is pressed by default.
    await screen.findByText(/24h 吞吐/i)
    const runsMin = screen.getByRole('button', { name: 'runs/min' })
    expect(runsMin).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'P95 延迟' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '失败率' })).toHaveAttribute('aria-pressed', 'false')
    // The throughput grid renders the live runs/min rate cell.
    expect(screen.getByTestId('throughput-grid')).toBeInTheDocument()
    expect(screen.getByText('runs 速率')).toBeInTheDocument()
  })
})

// ─── §M8.1 时间窗 segmented toggle → fetch ?window= ─────────────────────────

describe('DashboardView — time-window segmented toggle (M8.1)', () => {
  it('fetches ?window=24h on mount (the default preset)', async () => {
    await renderView()
    await screen.findByText(/注册 agents/i)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('window=24h'),
      expect.anything(),
    )
  })

  it('re-fetches with ?window=7d when the 7d preset is pressed', async () => {
    const user = userEvent.setup()
    await renderView()
    await screen.findByText(/注册 agents/i)

    await user.click(screen.getByRole('button', { name: '7d' }))

    // The toggle drives the fetch URL: state `window` → `?window=`.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('window=7d'),
        expect.anything(),
      )
    })
    // Single-select: 7d is now pressed, 24h released.
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('re-fetches with ?window=1h when the 1h preset is pressed', async () => {
    const user = userEvent.setup()
    await renderView()
    await screen.findByText(/注册 agents/i)

    await user.click(screen.getByRole('button', { name: '1h' }))

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('window=1h'),
        expect.anything(),
      )
    })
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true')
  })
})
